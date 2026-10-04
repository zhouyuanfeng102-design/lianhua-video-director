import { useEffect, useRef, useState } from 'react';
import { formatSafeErrorDiagnostics, getSafeErrorDiagnostics } from '../errorDiagnostics';
import { copyText } from '../storage';
import { formatUserFacingError } from '../userFacingError';

export interface TaskErrorDetailsProps {
  error: unknown;
  /** Optional primary cause for the compact summary. Details/copy always use
   * the complete error; this value receives identical privacy filtering. */
  summaryError?: unknown;
  knownSecrets?: readonly string[];
  sensitiveTexts?: readonly string[];
  className?: string;
}

/** Local display/copy only: expanding details never generates or retries a task. */
export function TaskErrorDetails({ error, summaryError, knownSecrets, sensitiveTexts, className }: TaskErrorDetailsProps) {
  const options = { knownSecrets, sensitiveTexts };
  const safeError = getSafeErrorDiagnostics(summaryError === undefined ? error : summaryError, options);
  const diagnostic = formatSafeErrorDiagnostics(error, options);
  const [copyResult, setCopyResult] = useState<{ diagnostic: string; epoch: number; state: 'pending' | 'success' | 'failed' } | null>(null);
  const mounted = useRef(true);
  const latestDiagnostic = useRef(diagnostic);
  latestDiagnostic.current = diagnostic;
  const copyEpoch = useRef(0);
  const pendingCopy = useRef<{ diagnostic: string; epoch: number } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      copyEpoch.current += 1;
      pendingCopy.current = null;
    };
  }, []);
  const currentCopy = copyResult?.diagnostic === diagnostic
    && copyResult.epoch === copyEpoch.current
    && (copyResult.state !== 'pending' || pendingCopy.current?.epoch === copyResult.epoch)
    ? copyResult.state : undefined;
  const copyDetails = async () => {
    if (latestDiagnostic.current !== diagnostic || pendingCopy.current?.diagnostic === diagnostic) return;
    const epoch = ++copyEpoch.current;
    pendingCopy.current = { diagnostic, epoch };
    setCopyResult({ diagnostic, epoch, state: 'pending' });
    const isCurrent = () => mounted.current && copyEpoch.current === epoch && latestDiagnostic.current === diagnostic;
    try {
      const copied = await copyText(diagnostic);
      if (isCurrent()) setCopyResult({ diagnostic, epoch, state: copied ? 'success' : 'failed' });
    } catch {
      if (isCurrent()) setCopyResult({ diagnostic, epoch, state: 'failed' });
    } finally {
      if (pendingCopy.current?.epoch === epoch) pendingCopy.current = null;
    }
  };

  return (
    <div className={['task-error-details', className].filter(Boolean).join(' ')}>
      <div className="task-error-summary">{formatUserFacingError(safeError)}</div>
      <details className="task-error-technical">
        <summary>查看错误详情</summary>
        <pre>{diagnostic}</pre>
        <button type="button" className="secondary" disabled={currentCopy === 'pending'} onClick={() => { void copyDetails(); }}>
          {currentCopy === 'pending' ? '复制中…' : '复制错误详情'}
        </button>
        <span role="status" aria-live="polite">
          {currentCopy === 'success' ? '已复制（敏感信息已脱敏）' : currentCopy === 'failed' ? '复制失败，请选中详情手动复制。' : ''}
        </span>
      </details>
    </div>
  );
}
