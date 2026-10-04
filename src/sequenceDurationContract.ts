/** Numeric delivery windows, not locally generated shots, prose or cuts.
 * AI must author the complete shots and group them within these user-owned
 * windows. Every segment has the requested duration. An explicitly unconfirmed
 * master may receive a revised AI-authored full duration together with its
 * complete timeline; callers never append a local filler or retime slices. */
export interface RequestedSegmentDurationWindow {
  index: number;
  globalStartSec: number;
  globalEndSec: number;
  durationSec: number;
}

/** AI-planned prompts support custom segment seconds; provider limits apply at video submission. */
export const MAX_PLANNED_SEQUENCE_SEGMENT_DURATION_SEC = 300;

const EPSILON = 0.005;
const formatSeconds = (value: number): string => Number.isFinite(value) ? String(Number(value.toFixed(3))) : String(value);
const units = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value <= 0 || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) {
    throw new Error(`${label}必须是大于0且最多两位小数的秒数。`);
  }
  return Math.round(value * 100);
};

/**
 * Structured, transport-only information about a master timeline contract
 * failure.  This is deliberately limited to numbers and shot positions: it
 * does not attempt to judge story quality, dialogue ownership or any other
 * semantic part of an AI-authored prompt.  Callers can pass this object back
 * to the same model so the model can repair the complete timeline itself.
 */
export type MasterSegmentDurationContractIssueKind =
  | 'empty'
  | 'invalid'
  | 'overflow'
  | 'gap-overlap'
  | 'missing-boundary';

export interface MasterSegmentDurationContractShotDiagnostic {
  /** One-based position in the AI response, suitable for a user-facing prompt. */
  shotIndex: number;
  startSec: number | null;
  endSec: number | null;
  previousEndSec: number | null;
}

export interface MasterSegmentDurationContractDiagnostic {
  kind: MasterSegmentDurationContractIssueKind;
  message: string;
  totalDurationSec: number;
  segmentDurationSec: number;
  /** The complete fixed grid when the contract can be constructed. */
  allWindows: RequestedSegmentDurationWindow[];
  /** The two grid windows surrounding each missing internal boundary. */
  expectedWindows: RequestedSegmentDurationWindow[];
  missingBoundaries: number[];
  crossingShots: Array<{ shotIndex: number; startSec: number; endSec: number }>;
  offendingShot?: MasterSegmentDurationContractShotDiagnostic;
}

/** Error thrown by the numeric master timeline contract.  The diagnostic is
 * attached instead of being reconstructed from localized prose by callers. */
export class MasterSegmentDurationContractError extends Error {
  readonly diagnostic: MasterSegmentDurationContractDiagnostic;

  constructor(diagnostic: MasterSegmentDurationContractDiagnostic) {
    super(diagnostic.message);
    this.name = 'MasterSegmentDurationContractError';
    this.diagnostic = diagnostic;
  }
}

/** A requested full-film budget only. This never rewrites an AI estimate,
 * shot, saved plan or story event; AI must author the resulting timeline. */
export const roundUpSequenceDurationToFullSegments = (totalDurationSec: number, segmentDurationSec: number): number => {
  const total = units(totalDurationSec, '全片总时长');
  const segment = units(segmentDurationSec, '所选单段时长');
  if (segment < 100 || segment > MAX_PLANNED_SEQUENCE_SEGMENT_DURATION_SEC * 100) throw new Error('所选单段时长必须为1–300秒。');
  const rounded = Math.ceil(total / segment) * segment / 100;
  if (rounded > 3600) throw new Error(`按每段${segmentDurationSec}秒足额生成需${rounded}秒，超过全片3600秒上限；请调整总时长或单段秒数。`);
  return rounded;
};

export const requestedSegmentDurationWindows = (totalDurationSec: number, segmentDurationSec: number): RequestedSegmentDurationWindow[] => {
  const total = units(totalDurationSec, '全片总时长');
  const segment = units(segmentDurationSec, '所选单段时长');
  if (total % segment !== 0) {
    throw new Error(`全片总时长${totalDurationSec}秒不是所选单段${segmentDurationSec}秒的整数倍；每段必须足额，不生成短尾段。请按${Math.ceil(total / segment) * segment / 100}秒重新由AI生成全片总稿，旧稿保持不变。`);
  }
  const count = total / segment;
  if (count > 900) throw new Error('所选单段时长需要超过900个生成窗口，请增大单段时长或缩短总时长。');
  return Array.from({ length: count }, (_, index) => {
    const start = index * segment;
    const end = Math.min(total, start + segment);
    return { index: index + 1, globalStartSec: start / 100, globalEndSec: end / 100, durationSec: (end - start) / 100 };
  });
};

const nullableSeconds = (value: number): number | null => Number.isFinite(value) ? value : null;

const diagnosticShot = (
  shotIndex: number,
  shot: { startSec: number; endSec: number } | undefined,
  previousEndSec: number | null,
): MasterSegmentDurationContractShotDiagnostic => ({
  shotIndex,
  startSec: shot ? nullableSeconds(shot.startSec) : null,
  endSec: shot ? nullableSeconds(shot.endSec) : null,
  previousEndSec,
});

const adjacentWindowsForBoundaries = (
  windows: readonly RequestedSegmentDurationWindow[],
  boundaries: readonly number[],
): RequestedSegmentDurationWindow[] => {
  const selected = new Set<number>();
  boundaries.forEach((boundary) => {
    const ending = windows.find((window) => Math.abs(window.globalEndSec - boundary) <= EPSILON);
    const starting = windows.find((window) => Math.abs(window.globalStartSec - boundary) <= EPSILON);
    if (ending) selected.add(ending.index);
    if (starting) selected.add(starting.index);
  });
  return windows.filter((window) => selected.has(window.index));
};

/**
 * Diagnose the numeric master-timeline contract without changing the AI
 * output.  A successful timeline returns undefined.  On failure, the result
 * contains the exact missing fixed-grid boundaries and the complete shots
 * crossing those boundaries, which is more reliable than asking a caller to
 * parse a localized error string.
 */
export const diagnoseMasterSegmentDurationContract = (
  shots: readonly { startSec: number; endSec: number }[],
  totalDurationSec: number,
  segmentDurationSec: number,
): MasterSegmentDurationContractDiagnostic | undefined => {
  const windows = requestedSegmentDurationWindows(totalDurationSec, segmentDurationSec);
  const base = (
    kind: MasterSegmentDurationContractIssueKind,
    message: string,
    extra: Partial<Omit<MasterSegmentDurationContractDiagnostic, 'kind' | 'message' | 'totalDurationSec' | 'segmentDurationSec' | 'allWindows'>> = {},
  ): MasterSegmentDurationContractDiagnostic => ({
    kind,
    message,
    totalDurationSec,
    segmentDurationSec,
    allWindows: [...windows],
    expectedWindows: [],
    missingBoundaries: [],
    crossingShots: [],
    ...extra,
  });

  if (!shots.length) {
    return base('empty', 'AI全片总稿缺少完整镜头。');
  }
  for (const [index, shot] of shots.entries()) {
    const start = index === 0 ? 0 : shots[index - 1].endSec;
    const context = `AI第${index + 1}镜（上一镜end=${formatSeconds(start)}秒，本镜start=${formatSeconds(shot.startSec)}秒，end=${formatSeconds(shot.endSec)}秒，有效总时长=${formatSeconds(totalDurationSec)}秒）`;
    if (!Number.isFinite(shot.startSec) || !Number.isFinite(shot.endSec) || shot.endSec <= shot.startSec) {
      const message = `[invalid] ${context}时间边界无效：start/end必须是有限数，且end必须大于start；请由AI修复数值边界并保留全部原文内容。`;
      return base('invalid', message, {
        offendingShot: diagnosticShot(index + 1, shot, nullableSeconds(start)),
      });
    }
    if (shot.endSec > totalDurationSec + EPSILON) {
      const message = `[overflow] ${context}超出有效总时长：end不得超过${formatSeconds(totalDurationSec)}秒；请由AI修复数值边界并保留全部原文内容。`;
      return base('overflow', message, {
        offendingShot: diagnosticShot(index + 1, shot, nullableSeconds(start)),
      });
    }
    if (Math.abs(shot.startSec - start) > EPSILON) {
      const relation = shot.startSec > start ? '存在间隙' : '与上一镜重叠';
      const message = `[gap-overlap] ${context}${relation}（差值${formatSeconds(Math.abs(shot.startSec - start))}秒）；请由AI修复相邻镜头边界并保留全部原文内容。`;
      return base('gap-overlap', message, {
        offendingShot: diagnosticShot(index + 1, shot, nullableSeconds(start)),
      });
    }
  }
  if (Math.abs(shots[shots.length - 1].endSec - totalDurationSec) > EPSILON) {
    const last = shots[shots.length - 1];
    const relation = last.endSec > totalDurationSec ? '超出有效总时长' : '未覆盖有效总时长，存在末尾间隙';
    const category = last.endSec > totalDurationSec ? 'overflow' : 'gap-overlap';
    const previousEndSec = shots.length > 1 ? shots[shots.length - 2].endSec : 0;
    const message = `[${category}] ${relation}：AI第${shots.length}镜（上一镜end=${formatSeconds(previousEndSec)}秒，本镜start=${formatSeconds(last.startSec)}秒，end=${formatSeconds(last.endSec)}秒，有效总时长=${formatSeconds(totalDurationSec)}秒）；全片必须结束在${formatSeconds(totalDurationSec)}秒。`;
    return base(category, message, {
      offendingShot: diagnosticShot(shots.length, last, nullableSeconds(previousEndSec)),
    });
  }
  const missingBoundaries = windows
    .slice(0, -1)
    .map((window) => window.globalEndSec)
    .filter((boundary) => !shots.some((shot) => Math.abs(shot.endSec - boundary) <= EPSILON));
  if (missingBoundaries.length) {
    const crossingShots = shots
      .map((shot, index) => ({ shotIndex: index + 1, startSec: shot.startSec, endSec: shot.endSec }))
      .filter(({ startSec, endSec }) => missingBoundaries.some((boundary) => startSec < boundary - EPSILON && endSec > boundary + EPSILON));
    const boundaryText = missingBoundaries.map((boundary) => `${formatSeconds(boundary)}秒`).join('、');
    const crossingText = crossingShots.length
      ? `；跨界镜头：${crossingShots.map((shot) => `第${shot.shotIndex}镜（${formatSeconds(shot.startSec)}–${formatSeconds(shot.endSec)}秒）`).join('、')}`
      : '';
    const message = `[missing-boundary] AI全片总稿缺少所选${segmentDurationSec}秒分段的${boundaryText}镜头边界（有效总时长=${formatSeconds(totalDurationSec)}秒）${crossingText}；必须由AI重新安排完整镜头和跨镜承接，不能本地截断镜头。`;
    return base('missing-boundary', message, {
      expectedWindows: adjacentWindowsForBoundaries(windows, missingBoundaries),
      missingBoundaries,
      crossingShots,
    });
  }
  return undefined;
};

export const assertMasterSegmentDurationContract = (
  shots: readonly { startSec: number; endSec: number }[],
  totalDurationSec: number,
  segmentDurationSec: number,
): void => {
  const diagnostic = diagnoseMasterSegmentDurationContract(shots, totalDurationSec, segmentDurationSec);
  if (diagnostic) throw new MasterSegmentDurationContractError(diagnostic);
};

export const assertSequenceSegmentDurationContract = (
  segments: readonly { globalStartSec?: number; globalEndSec?: number; durationSec?: number }[],
  totalDurationSec: number,
  segmentDurationSec: number,
): void => {
  const windows = requestedSegmentDurationWindows(totalDurationSec, segmentDurationSec);
  if (segments.length !== windows.length) {
    throw new Error(`所选单段${segmentDurationSec}秒、全片${totalDurationSec}秒必须由AI返回${windows.length}段且每段足额，实际返回${segments.length}段。`);
  }
  for (const [index, expected] of windows.entries()) {
    const actual = segments[index];
    if (['globalStartSec', 'globalEndSec', 'durationSec'].some((key) => {
      const field = key as 'globalStartSec' | 'globalEndSec' | 'durationSec';
      return typeof actual[field] !== 'number' || !Number.isFinite(actual[field]) || Math.abs(actual[field]! - expected[field]) > EPSILON;
    })) {
      throw new Error(`AI第${index + 1}段必须为${expected.globalStartSec}–${expected.globalEndSec}秒（${expected.durationSec}秒），所选${segmentDurationSec}秒不是软目标；请由同一AI修复分组，程序不会拆镜或裁剪正文。`);
    }
  }
};
