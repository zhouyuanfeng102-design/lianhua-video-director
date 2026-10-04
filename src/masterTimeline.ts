import type { Storyboard, VideoSequencePlan, VideoShot } from './types';
import { semanticActionsEquivalent } from './semanticEvents';
import { normalizeStoryboardSubject } from './storyboardSubject';

export interface ParsedMasterPromptEntry {
  startSec: number;
  endSec: number;
  prompt: string;
}

const REQUIRED_FIELDS = ['主体：', '空间：', '光影：', '镜头：', '台词：', '音效：'] as const;
const TIMESTAMP_HEADER = /^【(\d+(?:\.\d+)?)s-(\d+(?:\.\d+)?)s】[ \t]*/gmu;
const LEADING_TIMESTAMP_HEADER = /^【\d+(?:\.\d+)?s-\d+(?:\.\d+)?s】/u;
const VISIBLE_ACTION_START = /正在(?=\s|[\[［【])\s*|(?:动作链|动作)\s*[:：]\s*/u;
const BRACKET_PAIRS: Readonly<Record<string, string>> = {
  '[': ']',
  '［': '］',
  '（': '）',
  '(': ')',
  '{': '}',
  '【': '】',
  '《': '》',
};
const QUOTE_PAIRS: Readonly<Record<string, string>> = {
  '"': '"',
  '“': '”',
  '‘': '’',
  '「': '」',
  '『': '』',
};

const quoteCharacterEscaped = (source: string, index: number): boolean => {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
};

const isEnglishApostrophe = (source: string, index: number): boolean => (
  /[A-Za-z0-9]/u.test(source[index - 1] || '') && /[A-Za-z0-9]/u.test(source[index + 1] || '')
);

const openingQuoteFor = (source: string, index: number): string => {
  if (quoteCharacterEscaped(source, index)) return '';
  const character = source[index];
  if (QUOTE_PAIRS[character]) return QUOTE_PAIRS[character];
  if (character !== "'" || /[A-Za-z0-9]/u.test(source[index - 1] || '')) return '';
  // A closing mate makes this a quotation, not don't / a possessive apostrophe.
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "'" && !quoteCharacterEscaped(source, cursor) && !isEnglishApostrophe(source, cursor)) return "'";
  }
  return '';
};

/** Closed quoted text is authored wording, not executable field names/times. */
export const protectedTextQuoteSpans = (source: string): Array<{ start: number; end: number; content: string }> => {
  const spans: Array<{ start: number; end: number; content: string }> = [];
  for (let index = 0; index < source.length; index += 1) {
    const close = openingQuoteFor(source, index);
    if (!close) continue;
    for (let end = index + 1; end < source.length; end += 1) {
      if (source[end] !== close || quoteCharacterEscaped(source, end) || (close === "'" && isEnglishApostrophe(source, end))) continue;
      spans.push({ start: index, end: end + 1, content: source.slice(index + 1, end) });
      index = end;
      break;
    }
  }
  return spans;
};

const GRID_PRECISION = 100;

const gridCentiseconds = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label}必须是大于 0 的有限秒数。`);
  }
  const centiseconds = Math.round((value + Number.EPSILON) * GRID_PRECISION);
  if (Math.abs(value - centiseconds / GRID_PRECISION) > 1e-9) {
    throw new Error(`${label}必须精确到 0.01 秒。`);
  }
  return centiseconds;
};

const timelineCentiseconds = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label}必须是非负的有限秒数。`);
  }
  const centiseconds = Math.round((value + Number.EPSILON) * GRID_PRECISION);
  if (Math.abs(value - centiseconds / GRID_PRECISION) > 1e-9) {
    throw new Error(`${label}必须精确到 0.01 秒。`);
  }
  return centiseconds;
};

/** Return every internal fixed-segment boundary using centiseconds, never
 * floating-point remainders.  Callers can include this list in an AI request
 * before a master timeline exists. */
export const masterTimelineInternalSegmentBoundaries = (
  totalDurationSec: number,
  requiredSegmentDurationSec: number,
): number[] => {
  const totalCentiseconds = gridCentiseconds(totalDurationSec, '全片总时长');
  const segmentCentiseconds = gridCentiseconds(requiredSegmentDurationSec, '固定分段时长');
  if (totalCentiseconds % segmentCentiseconds !== 0) {
    throw new Error(
      `全片总时长 ${totalDurationSec} 秒必须是固定分段时长 ${requiredSegmentDurationSec} 秒的整数倍。`,
    );
  }
  const boundaries: number[] = [];
  for (let boundary = segmentCentiseconds; boundary < totalCentiseconds; boundary += segmentCentiseconds) {
    boundaries.push(boundary / GRID_PRECISION);
  }
  return boundaries;
};

/** Reject a master shot that crosses a required fixed-segment boundary. */
export const validateMasterTimelineSegmentGrid = (
  shots: readonly Pick<VideoShot, 'startSec' | 'endSec'>[],
  totalDurationSec: number,
  requiredSegmentDurationSec: number | undefined,
): void => {
  if (requiredSegmentDurationSec === undefined) return;
  const boundaries = masterTimelineInternalSegmentBoundaries(
    totalDurationSec,
    requiredSegmentDurationSec,
  );
  const normalizedShots = shots.map((shot, index) => ({
    index,
    startCentiseconds: timelineCentiseconds(shot.startSec, `第 ${index + 1} 镜开始时间`),
    endCentiseconds: timelineCentiseconds(shot.endSec, `第 ${index + 1} 镜结束时间`),
  }));
  boundaries.forEach((boundarySec) => {
    const boundary = Math.round(boundarySec * GRID_PRECISION);
    const endingIndex = normalizedShots.findIndex((shot) => shot.endCentiseconds === boundary);
    const beginningIndex = endingIndex >= 0 && normalizedShots[endingIndex + 1]?.startCentiseconds === boundary
      ? endingIndex + 1
      : -1;
    if (endingIndex >= 0 && beginningIndex >= 0) return;
    const crossing = normalizedShots.find((shot) => (
      shot.startCentiseconds < boundary && shot.endCentiseconds > boundary
    ));
    if (crossing) {
      throw new Error(
        `固定分段网格在 ${boundarySec} 秒缺少完整镜头边界：第 ${crossing.index + 1} 镜跨越该硬边界。`,
      );
    }
    throw new Error(`固定分段网格在 ${boundarySec} 秒缺少完整镜头硬边界。`);
  });
};

interface TopLevelCanonicalFieldLocation {
  field: typeof REQUIRED_FIELDS[number];
  start: number;
}

export const topLevelCanonicalFieldLocations = (body: string): TopLevelCanonicalFieldLocation[] => {
  const fields: TopLevelCanonicalFieldLocation[] = body.startsWith(REQUIRED_FIELDS[0])
    ? [{ field: REQUIRED_FIELDS[0], start: 0 }]
    : [];
  const closingBrackets: string[] = [];
  let closingQuote = '';

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (closingQuote) {
      if (character === closingQuote && !quoteCharacterEscaped(body, index) && (closingQuote !== "'" || !isEnglishApostrophe(body, index))) closingQuote = '';
      else if (character === closingBrackets[closingBrackets.length - 1]) {
        // Canonical action chains and other nested atoms are explicitly
        // bounded. An orphan quote inside one must not swallow the closing
        // bracket and every later top-level field in an otherwise recoverable
        // legacy prompt.
        closingQuote = '';
        closingBrackets.pop();
      }
      continue;
    }
    const quoteEnd = openingQuoteFor(body, index);
    if (quoteEnd) {
      closingQuote = quoteEnd;
      continue;
    }
    const bracketEnd = BRACKET_PAIRS[character];
    if (bracketEnd) {
      closingBrackets.push(bracketEnd);
      continue;
    }
    if (character === closingBrackets[closingBrackets.length - 1]) {
      closingBrackets.pop();
      continue;
    }
    if (character !== '；' || closingBrackets.length) continue;

    let fieldStart = index + 1;
    while (/\s/u.test(body[fieldStart] || '')) fieldStart += 1;
    const field = REQUIRED_FIELDS.find((candidate) => body.startsWith(candidate, fieldStart));
    if (field) fields.push({ field, start: fieldStart });
  }
  return fields;
};

const topLevelCanonicalFields = (body: string): string[] => (
  topLevelCanonicalFieldLocations(body).map(({ field }) => field)
);

/** Locate only the top-level spoken field, never a label inside quoted text. */
export const canonicalDialogueFieldRange = (prompt: string): { start: number; end: number } | undefined => {
  const source = String(prompt || '');
  const headerLength = source.match(LEADING_TIMESTAMP_HEADER)?.[0].length || 0;
  const bodyOffset = headerLength + (source.slice(headerLength).match(/^\s*/u)?.[0].length || 0);
  const body = source.slice(bodyOffset);
  const fields = topLevelCanonicalFieldLocations(body);
  const index = fields.findIndex(({ field }) => field === '台词：');
  if (index < 0) return undefined;
  const valueStart = fields[index].start + fields[index].field.length;
  const fieldValue = body.slice(valueStart, fields[index + 1]?.start).replace(/[；;]\s*$/u, '');
  return { start: bodyOffset + valueStart, end: bodyOffset + valueStart + fieldValue.length };
};

/** Read spoken text without mistaking quoted field labels for real fields. */
export const canonicalDialogueField = (prompt: string): string => {
  const range = canonicalDialogueFieldRange(prompt);
  return range ? String(prompt || '').slice(range.start, range.end).trim() : '';
};

export const replaceCanonicalDialogueField = (prompt: string, replace: (field: string) => string): string => {
  const range = canonicalDialogueFieldRange(prompt);
  if (!range) return prompt;
  return prompt.slice(0, range.start) + replace(prompt.slice(range.start, range.end)) + prompt.slice(range.end);
};

const canonicalSoundFieldRange = (prompt: string): { start: number; end: number } | undefined => {
  const header = String(prompt || '').match(LEADING_TIMESTAMP_HEADER);
  const bodyOffset = header?.[0].length || 0;
  const body = String(prompt || '').slice(bodyOffset);
  const soundField = topLevelCanonicalFieldLocations(body)
    .find(({ field }) => field === '音效：');
  if (!soundField) return undefined;
  return {
    start: bodyOffset + soundField.start + soundField.field.length,
    end: String(prompt || '').length,
  };
};

const visibleActionChain = (prompt: string): string | undefined => {
  const range = canonicalSubjectFieldRange(prompt);
  const subjectField = range ? prompt.slice(range.start, range.end) : undefined;
  const marker = subjectField?.match(VISIBLE_ACTION_START);
  if (!subjectField || !marker) return undefined;
  const value = subjectField.slice(marker.index! + marker[0].length).replace(/[；;]\s*$/u, '').trim();
  const closing = ({ '[': ']', '［': '］', '【': '】' } as Record<string, string>)[value[0]];
  // Bracket spelling is presentation. Read only an explicit action slot,
  // never infer actions from another field or fall back to an old shot.
  const end = closing ? value.indexOf(closing, 1) : value.length;
  if (end < 0) return undefined;
  const raw = closing ? value.slice(1, end) : value;
  const normalized = raw
    .split('→')
    .map((stage) => stage.replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .join('→');
  return normalized || undefined;
};

/** A quoted “；空间：” inside an authored action is not the next field. */
const canonicalSubjectFieldRange = (prompt: string): { start: number; end: number } | undefined => {
  const headerLength = prompt.match(LEADING_TIMESTAMP_HEADER)?.[0].length || 0;
  const bodyOffset = headerLength + (prompt.slice(headerLength).match(/^\s*/u)?.[0].length || 0);
  const body = prompt.slice(bodyOffset);
  const fields = topLevelCanonicalFieldLocations(body);
  const subjectIndex = fields.findIndex(({ field }) => field === '主体：');
  if (subjectIndex < 0) return undefined;
  return {
    start: bodyOffset + fields[subjectIndex].start + '主体：'.length,
    end: bodyOffset + (fields[subjectIndex + 1]?.start ?? body.length),
  };
};

/** Locate the complete displayed identity, including spaces and parentheses
 * within a name. The final performance group before the direction/action
 * marker is presentation, not part of the identity. Offsets include @. */
export const canonicalSubjectIdentityRange = (prompt: string): {
  start: number; end: number; subject: string; hasMarker: boolean;
} | undefined => {
  const range = canonicalSubjectFieldRange(prompt);
  if (!range) return undefined;
  const field = prompt.slice(range.start, range.end).replace(/；\s*$/u, '');
  const fieldStart = range.start;
  const start = field.length - field.trimStart().length;
  const marker = field.match(/(?:\[|［)朝向[：:]|正在(?=\s|[\[［【])|(?:动作链|动作)\s*[:：]/u);
  let end = (marker ? field.slice(0, marker.index) : field).trimEnd().length;
  const closing = field[end - 1];
  const opening = closing === '）' ? '（' : closing === ')' ? '(' : '';
  if (opening) {
    let depth = 0;
    for (let index = end - 1; index >= start; index -= 1) {
      if (field[index] === closing) depth += 1;
      if (field[index] === opening) depth -= 1;
      if (depth === 0) {
        end = field.slice(0, index).trimEnd().length;
        break;
      }
    }
  }
  if (end <= start) return undefined;
  const label = field.slice(start, end);
  const subject = normalizeStoryboardSubject(label);
  return subject ? {
    start: fieldStart + start,
    end: fieldStart + end,
    subject,
    hasMarker: /^[@＠]/u.test(label),
  } : undefined;
};

const visibleSubject = (prompt: string): string | undefined => {
  const identity = canonicalSubjectIdentityRange(prompt);
  return identity?.hasMarker ? identity.subject : undefined;
};

const canonicalPromptBody = (prompt: string): string => String(prompt || '')
  .replace(LEADING_TIMESTAMP_HEADER, '')
  .replace(/\s+/gu, ' ')
  .trim();

interface ShotSemantics {
  subject: string;
  action: string;
  promptBody: string;
}

const resolveEditedShotOrigins = (
  shots: readonly VideoShot[],
  edited: readonly ShotSemantics[],
): number[] => {
  const modelAuthored = shots.length > 0 && shots.every((shot) => shot.authoredBy === 'text-api');
  // A wording heuristic is not proof that a user's rewritten AI shot still
  // depicts the same source passage. Exact bodies/actions may carry their
  // provenance; otherwise accept the text and clear unverified provenance.
  const sameAction = modelAuthored
    ? (left: string, right: string) => left.replace(/\s+/gu, ' ').trim() === right.replace(/\s+/gu, ' ').trim()
    : semanticActionsEquivalent;
  const original = shots.map((shot): ShotSemantics => {
    const promptSubject = visibleSubject(shot.prompt);
    const promptAction = visibleActionChain(shot.prompt);
    return {
      subject: promptSubject || String(shot.subject || '').trim(),
      action: promptAction || String(shot.action || '').trim(),
      promptBody: canonicalPromptBody(shot.prompt),
    };
  });
  const origins = Array.from({ length: edited.length }, () => -1);
  const used = new Set<number>();

  const assignCandidates = (
    matches: (entry: ShotSemantics, source: ShotSemantics) => boolean,
  ): void => {
    let assigned = true;
    while (assigned) {
      assigned = false;
      edited.forEach((entry, entryIndex) => {
        if (origins[entryIndex] >= 0) return;
        const candidates = original
          .map((source, sourceIndex) => ({ source, sourceIndex }))
          .filter(({ source, sourceIndex }) => !used.has(sourceIndex) && matches(entry, source))
          .map(({ sourceIndex }) => sourceIndex);
        if (candidates.length !== 1) return;
        origins[entryIndex] = candidates[0];
        used.add(candidates[0]);
        assigned = true;
      });
    }

    edited.forEach((entry, entryIndex) => {
      if (origins[entryIndex] >= 0 || used.has(entryIndex)) return;
      if (!matches(entry, original[entryIndex])) return;
      origins[entryIndex] = entryIndex;
      used.add(entryIndex);
    });
  };

  // A complete prompt body (excluding only its time header) is the strongest
  // evidence that a user moved an existing shot to a new timeline position.
  assignCandidates((entry, source) => Boolean(
    entry.promptBody
    && source.promptBody
    && entry.promptBody === source.promptBody
  ));
  assignCandidates((entry, source) => (
    entry.subject === source.subject
    && sameAction(entry.action, source.action)
  ));
  // Subject renaming is a supported visible edit.  A unique equivalent action
  // still identifies its original semantic source without trusting the slot.
  assignCandidates((entry, source) => sameAction(entry.action, source.action));

  // Some legacy/in-memory callers hold the aggregate prompt separately while
  // each shot.prompt is still empty.  There is no earlier visible body to
  // compare in that shape, so retain its only available provenance contract:
  // the unchanged timeline slot.  Persisted master boards have per-shot
  // prompts and therefore never use this compatibility path for reordering.
  edited.forEach((_entry, entryIndex) => {
    if (
      origins[entryIndex] < 0
      && !used.has(entryIndex)
      && !original[entryIndex].promptBody
      && !modelAuthored
    ) {
      origins[entryIndex] = entryIndex;
      used.add(entryIndex);
    }
  });

  const hasBeatProvenance = shots.some(
    (shot) => Array.isArray(shot.sourceBeatIds) && shot.sourceBeatIds.length > 0,
  );
  const unresolvedIndex = origins.findIndex((origin) => origin < 0);
  if (hasBeatProvenance && unresolvedIndex >= 0 && !modelAuthored) {
    throw new Error(
      `第 ${unresolvedIndex + 1} 镜的编辑内容无法与原镜头唯一对应，不能安全保留剧情节拍来源；请恢复原镜头语义或重新生成总提示词。`,
    );
  }
  return origins.map((origin, index) => origin >= 0 ? origin : modelAuthored ? -1 : index);
};

export function parseMasterTimelinePrompt(
  prompt: string,
  expectedDurationSec: number,
  requiredSegmentDurationSec?: number,
): ParsedMasterPromptEntry[] {
  if (!Number.isFinite(expectedDurationSec) || expectedDurationSec <= 0) {
    throw new Error('总时长必须是大于 0 的有限数字。');
  }

  const canonicalPrompt = String(prompt || '').replace(/^\uFEFF/u, '').trim();
  if (!canonicalPrompt) throw new Error('总提示词不能为空。');

  const matches = Array.from(canonicalPrompt.matchAll(TIMESTAMP_HEADER));
  if (!matches.length) throw new Error('总提示词缺少逐镜时间头。');
  if (matches[0].index !== 0) throw new Error('总提示词必须直接从第一镜时间头开始。');

  const entries = matches.map((match, index): ParsedMasterPromptEntry => {
    const startSec = Number(match[1]);
    const endSec = Number(match[2]);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
      throw new Error(`第 ${index + 1} 镜必须具有正时长。`);
    }

    const entryEnd = matches[index + 1]?.index ?? canonicalPrompt.length;
    const bodyStart = (match.index ?? 0) + match[0].length;
    const body = canonicalPrompt.slice(bodyStart, entryEnd).trim();
    if (!body) throw new Error(`第 ${index + 1} 镜正文不能为空。`);

    const topLevelFields = topLevelCanonicalFields(body);
    const missingField = REQUIRED_FIELDS.find((field) => !topLevelFields.includes(field));
    if (missingField) {
      throw new Error(`第 ${index + 1} 镜缺少必填字段“${missingField.slice(0, -1)}”。`);
    }
    if (topLevelFields.length !== REQUIRED_FIELDS.length
      || topLevelFields.some((field, fieldIndex) => field !== REQUIRED_FIELDS[fieldIndex])) {
      throw new Error(`第 ${index + 1} 镜的主体、空间、光影、镜头、台词、音效字段顺序无效。`);
    }

    return {
      startSec,
      endSec,
      prompt: canonicalPrompt.slice(match.index ?? 0, entryEnd).trim(),
    };
  });

  if (entries[0].startSec !== 0) {
    throw new Error('第一镜必须从 0 秒开始。');
  }
  for (let index = 1; index < entries.length; index += 1) {
    const previousEnd = entries[index - 1].endSec;
    const currentStart = entries[index].startSec;
    if (currentStart > previousEnd) {
      throw new Error(`第 ${index} 镜与第 ${index + 1} 镜之间存在时间空档。`);
    }
    if (currentStart < previousEnd) {
      throw new Error(`第 ${index} 镜与第 ${index + 1} 镜之间存在时间重叠。`);
    }
  }
  const finalEndSec = entries[entries.length - 1].endSec;
  if (finalEndSec !== expectedDurationSec) {
    throw new Error(`最终结束时间 ${finalEndSec} 秒与总时长 ${expectedDurationSec} 秒不一致。`);
  }
  validateMasterTimelineSegmentGrid(entries, expectedDurationSec, requiredSegmentDurationSec);

  return entries;
}

export function applyMasterPromptEdit(
  shots: readonly VideoShot[],
  prompt: string,
  expectedDurationSec: number,
  requiredSegmentDurationSec?: number,
): VideoShot[] {
  const entries = parseMasterTimelinePrompt(prompt, expectedDurationSec, requiredSegmentDurationSec);
  if (entries.length !== shots.length) {
    throw new Error(`镜头数量不能通过总提示词编辑改变：原有 ${shots.length} 镜，编辑后 ${entries.length} 镜。`);
  }
  const editedSemantics = entries.map((entry, index): ShotSemantics => {
    const subject = visibleSubject(entry.prompt);
    if (!subject) {
      throw new Error(`第 ${index + 1} 镜主体字段缺少有效的“@主体名”。`);
    }
    const action = visibleActionChain(entries[index].prompt);
    if (!action) {
      throw new Error(`第 ${index + 1} 镜主体字段缺少有效的“正在 [动作链]”结构。`);
    }
    if (shots[index]?.authoredBy !== 'text-api') {
      assertCanonicalPromptRelativeSoundCueTimes(
        entry.prompt,
        entry.endSec - entry.startSec,
        `第 ${index + 1} 镜音效`,
      );
    }
    return {
      subject,
      action,
      promptBody: canonicalPromptBody(entry.prompt),
    };
  });
  const semanticOrigins = resolveEditedShotOrigins(shots, editedSemantics);
  return shots.map((shot, index) => {
    const semantics = editedSemantics[index];
    const sourceVerified = semanticOrigins[index] >= 0;
    const originShot = sourceVerified ? shots[semanticOrigins[index]] : shot;
    const unchangedModelBody = originShot.authoredBy === 'text-api'
      && Boolean(originShot.prompt.trim())
      && semantics.promptBody === canonicalPromptBody(originShot.prompt);
    const editedShot: VideoShot = {
      ...(unchangedModelBody ? originShot : shot),
      id: shot.id,
      index: shot.index,
      startSec: entries[index].startSec,
      endSec: entries[index].endSec,
      subject: semantics.subject,
      // Confirming an unchanged AI draft must not copy presentation wrappers
      // or delimiter escaping back over the original model-authored action.
      action: unchangedModelBody ? originShot.action : semantics.action,
      referenceAssetIds: [...originShot.referenceAssetIds],
      prompt: entries[index].prompt,
    };
    if (!sourceVerified) {
      delete editedShot.sourceBeatIds;
      delete editedShot.sourceStart;
      delete editedShot.sourceEnd;
      delete editedShot.sourceExcerpt;
      editedShot.sourceLocationStatus = 'unlocated';
      return editedShot;
    }
    if (originShot.sourceBeatIds === undefined) delete editedShot.sourceBeatIds;
    else editedShot.sourceBeatIds = [...originShot.sourceBeatIds];
    if (originShot.sourceStart === undefined) delete editedShot.sourceStart;
    else editedShot.sourceStart = originShot.sourceStart;
    if (originShot.sourceEnd === undefined) delete editedShot.sourceEnd;
    else editedShot.sourceEnd = originShot.sourceEnd;
    if (originShot.sourceExcerpt === undefined) delete editedShot.sourceExcerpt;
    else editedShot.sourceExcerpt = originShot.sourceExcerpt;
    if (originShot.sourceLocationStatus === undefined) delete editedShot.sourceLocationStatus;
    else editedShot.sourceLocationStatus = originShot.sourceLocationStatus;
    return editedShot;
  });
}

/**
 * Apply a converter response by immutable timeline slot. This only parses the
 * fields needed to synchronize shot metadata; it does not grade prompt quality.
 * Unlike a user-authored master edit, conversion is not allowed to reorder
 * shots, so a substantial wording rewrite must not trigger semantic-origin
 * remapping or discard the source-beat provenance already owned by each slot.
 */
export function applyConvertedPromptToShots(
  shots: readonly VideoShot[],
  prompt: string,
  expectedDurationSec: number,
  requiredSegmentDurationSec?: number,
): VideoShot[] {
  const entries = parseMasterTimelinePrompt(prompt, expectedDurationSec, requiredSegmentDurationSec);
  if (entries.length !== shots.length) {
    throw new Error(`转换器不能改变镜头数量：原有 ${shots.length} 镜，转换后 ${entries.length} 镜。`);
  }
  return shots.map((shot, index) => {
    const entry = entries[index];
    const subject = visibleSubject(entry.prompt);
    if (!subject) {
      throw new Error(`第 ${index + 1} 镜主体字段缺少有效的“@主体名”。`);
    }
    const action = visibleActionChain(entry.prompt);
    if (!action) {
      throw new Error(`第 ${index + 1} 镜主体字段缺少有效的“正在 [动作链]”结构。`);
    }
    return {
      ...shot,
      startSec: entry.startSec,
      endSec: entry.endSec,
      subject,
      action,
      prompt: entry.prompt,
    };
  });
}

const formatTimestampSeconds = (value: number): string => {
  const rounded = Math.round((value + Number.EPSILON) * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

export const soundCueTimestampPattern = (): RegExp => /第(\s*)(-?\d+(?:\.\d+)?)(\s*)(s|秒)/giu;

/** Enforce the canonical contract that every sound cue is timed from the
 * beginning of its own shot, never from the whole-film timeline. */
export const assertRelativeSoundCueTimes = (
  soundText: string,
  shotDurationSec: number,
  label = '音效',
): void => {
  if (!Number.isFinite(shotDurationSec) || shotDurationSec <= 0) {
    throw new Error(`${label}无法使用无效的本镜时长。`);
  }
  const source = String(soundText || '');
  const quoted = protectedTextQuoteSpans(source);
  for (const cue of source.matchAll(soundCueTimestampPattern())) {
    if (quoted.some((span) => cue.index! >= span.start && cue.index! < span.end)) continue;
    const cueSec = Number(cue[2]);
    if (Number.isFinite(cueSec) && cueSec >= 0 && cueSec <= shotDurationSec + 0.001) continue;
    throw new Error(
      `${label}中的声音时刻“第${cue[2]}${cue[4]}”超出本镜相对时间 0-${formatTimestampSeconds(shotDurationSec)}s；声音时刻必须相对本镜开始。`,
    );
  }
};

/** Validate only the top-level canonical sound field. Dialogue timestamps and
 * quoted numbers in other fields are deliberately outside this contract. */
export const assertCanonicalPromptRelativeSoundCueTimes = (
  prompt: string,
  shotDurationSec: number,
  label = '音效',
): void => {
  const range = canonicalSoundFieldRange(prompt);
  if (!range) throw new Error(`${label}缺少可识别的音效字段。`);
  assertRelativeSoundCueTimes(String(prompt || '').slice(range.start, range.end), shotDurationSec, label);
};

/** Compatibility repair for legacy master shots whose AI-authored sound cue
 * accidentally used a whole-film timestamp. Only an unambiguous out-of-range
 * cue that still falls inside this master shot is rebased. */
export const normalizeAbsoluteSoundCueTimes = (
  soundText: string,
  masterShotStartSec: number,
  masterShotEndSec: number,
): string => {
  const source = String(soundText || '');
  const durationSec = masterShotEndSec - masterShotStartSec;
  if (
    !Number.isFinite(masterShotStartSec)
    || !Number.isFinite(masterShotEndSec)
    || durationSec <= 0
  ) return source;
  const quoted = protectedTextQuoteSpans(source);
  return source.replace(
    soundCueTimestampPattern(),
    (match, beforeNumber: string, rawSeconds: string, afterNumber: string, unit: string, offset: number) => {
      if (quoted.some((span) => offset >= span.start && offset < span.end)) return match;
      const cueSec = Number(rawSeconds);
      const isUnambiguousWholeFilmCue = Number.isFinite(cueSec)
        && cueSec > durationSec + 0.001
        && cueSec >= masterShotStartSec - 0.001
        && cueSec <= masterShotEndSec + 0.001;
      if (!isUnambiguousWholeFilmCue) return match;
      return `第${beforeNumber}${formatTimestampSeconds(cueSec - masterShotStartSec)}${afterNumber}${unit}`;
    },
  );
};

export const normalizeMasterShotPromptSoundCueTimes = (
  prompt: string,
  masterShotStartSec: number,
  masterShotEndSec: number,
): string => {
  const source = String(prompt || '');
  const range = canonicalSoundFieldRange(source);
  if (!range) return source;
  const normalizedSound = normalizeAbsoluteSoundCueTimes(
    source.slice(range.start, range.end),
    masterShotStartSec,
    masterShotEndSec,
  );
  return `${source.slice(0, range.start)}${normalizedSound}${source.slice(range.end)}`;
};

/** Derive a compatible sound timeline from a saved canonical prompt. Keep
 * headers, dialogue, formatting and all non-sound text byte-for-byte; only
 * unambiguous out-of-shot sound times are mapped to their own shot's zero.
 * The optional offset restores whole-film coordinates for saved segments. */
export const normalizeCanonicalTimelineSoundCueTimes = (
  prompt: string,
  timelineGlobalStartSec = 0,
): string => {
  const source = String(prompt || '');
  if (!Number.isFinite(timelineGlobalStartSec) || timelineGlobalStartSec < 0) return source;
  const headers = Array.from(source.matchAll(TIMESTAMP_HEADER));
  if (!headers.length) return source;
  return source.slice(0, headers[0].index) + headers.map((header, index) => {
    const startSec = Number(header[1]);
    const endSec = Number(header[2]);
    const shotPrompt = source.slice(header.index, headers[index + 1]?.index ?? source.length);
    const globalNormalized = normalizeMasterShotPromptSoundCueTimes(
      shotPrompt,
      timelineGlobalStartSec + startSec,
      timelineGlobalStartSec + endSec,
    );
    // Some legacy converters used segment-wide (rather than whole-film)
    // times. Already-correct relative values cannot exceed the shot duration
    // and are deliberately left alone by both passes.
    return timelineGlobalStartSec > 0
      ? normalizeMasterShotPromptSoundCueTimes(globalNormalized, startSec, endSec)
      : globalNormalized;
  }).join('');
};

export function retimeMasterShotPrompt(
  prompt: string,
  localStartSec: number,
  localEndSec: number,
): string {
  if (!Number.isFinite(localStartSec)
    || !Number.isFinite(localEndSec)
    || localStartSec < 0
    || localEndSec <= localStartSec) {
    throw new Error('局部镜头时间必须是非负且具有正时长的有限数字。');
  }
  if (!LEADING_TIMESTAMP_HEADER.test(prompt)) {
    throw new Error('镜头提示词缺少前导时间戳。');
  }
  const formattedStartSec = formatTimestampSeconds(localStartSec);
  const formattedEndSec = formatTimestampSeconds(localEndSec);
  if (Number(formattedEndSec) <= Number(formattedStartSec)) {
    throw new Error('局部镜头时间格式化后必须保持正时长。');
  }
  const timestamp = `【${formattedStartSec}s-${formattedEndSec}s】`;
  return prompt.replace(LEADING_TIMESTAMP_HEADER, timestamp);
}

const stableHash128 = (value: string): string => {
  let first = 1779033703;
  let second = 3144134277;
  let third = 1013904242;
  let fourth = 2773480762;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = second ^ Math.imul(first ^ code, 597399067);
    second = third ^ Math.imul(second ^ code, 2869860233);
    third = fourth ^ Math.imul(third ^ code, 951274213);
    fourth = first ^ Math.imul(fourth ^ code, 2716044179);
  }
  first = Math.imul(third ^ (first >>> 18), 597399067);
  second = Math.imul(fourth ^ (second >>> 22), 2869860233);
  third = Math.imul(first ^ (third >>> 17), 951274213);
  fourth = Math.imul(second ^ (fourth >>> 19), 2716044179);
  first ^= second ^ third ^ fourth;
  second ^= first;
  third ^= first;
  fourth ^= first;
  return [first, second, third, fourth]
    .map((part) => (part >>> 0).toString(16).padStart(8, '0'))
    .join('');
};

export function masterPromptConfirmationFingerprint(
  plan: Pick<VideoSequencePlan, 'id' | 'sourceStoryContent' | 'totalDurationSec' | 'segmentDurationSec' | 'masterStoryboardId'>,
  board: Pick<Storyboard, 'id' | 'finalPrompt' | 'shots'>,
): string {
  const fingerprintInput = JSON.stringify([
    plan.id,
    plan.sourceStoryContent,
    plan.totalDurationSec,
    Math.round(plan.segmentDurationSec * GRID_PRECISION) / GRID_PRECISION,
    plan.masterStoryboardId ?? '',
    board.id,
    board.finalPrompt,
    board.shots.map((shot) => [
      shot.id,
      shot.startSec,
      shot.endSec,
      shot.subject,
      shot.action,
      shot.sourceBeatIds ?? [],
      shot.sourceStart,
      shot.sourceEnd,
      shot.referenceAssetIds,
      shot.prompt,
    ]),
  ]);
  return `master-${stableHash128(fingerprintInput)}`;
}
