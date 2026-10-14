import { createRuntimeErrorLogEntry } from './runtimeErrorLog';
import type { SemanticSequencePlannerProgress } from './services/semanticSequencePlanner';

export const SEMANTIC_PLANNING_DIAGNOSTIC_KEY = 'lianhua_semantic_planning_diagnostics_v1';
const MAX_DIAGNOSTICS = 40;

export interface SemanticPlanningStatus extends Omit<SemanticSequencePlannerProgress, 'stage'> {
  stage: SemanticSequencePlannerProgress['stage'] | 'preparing' | 'stopped';
  operationId: string;
  projectId: string;
  chapterId?: string;
  updatedAt: number;
  provider: string;
  model: string;
}

interface DiagnosticStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Select only operational metadata; never retain the API config or story. */
export const createSemanticPlanningStatus = (
  progress: Omit<SemanticSequencePlannerProgress, 'stage'> & { stage: SemanticPlanningStatus['stage'] },
  context: { operationId: string; projectId: string; chapterId?: string; provider: string; model: string; apiKey?: string },
  now = Date.now(),
): SemanticPlanningStatus => {
  const clean = (text: string, limit: number): string => (createRuntimeErrorLogEntry({
    stage: 'sequence-semantic-planning', error: text, knownSecrets: [context.apiKey || ''],
  })?.message || '').slice(0, limit);
  return {
    operationId: context.operationId,
    projectId: context.projectId,
    ...(context.chapterId ? { chapterId: context.chapterId } : {}),
    updatedAt: now,
    provider: clean(context.provider, 80),
    model: clean(context.model, 160),
    stage: progress.stage,
    requestNumber: progress.requestNumber,
    maxRequests: progress.maxRequests,
    elapsedMs: progress.elapsedMs,
    durationMode: progress.durationMode,
    segmentDurationSec: progress.segmentDurationSec,
    ...(progress.totalDurationSec !== undefined ? { totalDurationSec: progress.totalDurationSec } : {}),
    ...(progress.requiredSegmentCount !== undefined ? { requiredSegmentCount: progress.requiredSegmentCount } : {}),
    ...(progress.detail ? { detail: clean(progress.detail, 800) } : {}),
  };
};

/** One bounded record per operation, separate from project state/error counts. */
export const recordSemanticPlanningDiagnostic = (
  status: SemanticPlanningStatus,
  storage?: DiagnosticStorage,
): void => {
  try {
    const target = storage || (typeof window !== 'undefined' ? window.localStorage : undefined);
    if (!target) return;
    const saved: unknown = JSON.parse(target.getItem(SEMANTIC_PLANNING_DIAGNOSTIC_KEY) || '[]');
    const entries = Array.isArray(saved) ? saved : [];
    const previous = entries.find((entry) => entry?.operationId === status.operationId);
    const requests = Array.isArray(previous?.requests) ? previous.requests : [];
    const previousRequest = requests.find((entry: { requestNumber?: number }) => entry?.requestNumber === status.requestNumber);
    const snapshot = {
      requestNumber: status.requestNumber, stage: status.stage, elapsedMs: status.elapsedMs,
      ...(status.detail || previousRequest?.detail ? { detail: status.detail || previousRequest.detail } : {}),
    };
    const incoming = { ...status, requests: [
      ...requests.filter((entry: { requestNumber?: number }) => entry?.requestNumber !== status.requestNumber),
      snapshot,
    ].slice(-status.maxRequests - 1) };
    target.setItem(SEMANTIC_PLANNING_DIAGNOSTIC_KEY, JSON.stringify([
      incoming, ...entries.filter((entry) => entry?.operationId !== status.operationId),
    ].slice(0, MAX_DIAGNOSTICS)));
  } catch {
    // Diagnostic storage failures must never interrupt or repeat a paid request.
  }
};

export const semanticPlanningElapsedMs = (status: SemanticPlanningStatus, now = Date.now()): number => (
  status.elapsedMs + (['completed', 'failed', 'stopped'].includes(status.stage) ? 0 : Math.max(0, now - status.updatedAt))
);

export const semanticPlanningStatusText = (status: SemanticPlanningStatus, now = Date.now()): string => {
  const labels: Record<SemanticPlanningStatus['stage'], string> = {
    preparing: '准备当前完整剧情', requesting: '等待接口完整响应', parsing: '解析分段结果',
    materializing: '整理分段计划', repairing: '现有技术恢复', completed: '分段完成',
    failed: '本次分段未完成', stopped: '分段已停止',
  };
  const seconds = Math.floor(semanticPlanningElapsedMs(status, now) / 1000);
  const time = seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`;
  return `${labels[status.stage]}${status.requestNumber ? ` · 第 ${status.requestNumber} 次请求` : ''} · 已用时 ${time}`;
};
