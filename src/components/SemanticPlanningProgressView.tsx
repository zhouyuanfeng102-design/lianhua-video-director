import { useEffect, useState } from 'react';
import { copyText } from '../storage';
import { semanticPlanningElapsedMs, semanticPlanningStatusText, type SemanticPlanningStatus } from '../semanticSequenceProgress';

/** The clock rerenders only this display, not the planner's existing checks. */
export const SemanticPlanningProgressView = ({ status, notify }: {
  status: SemanticPlanningStatus;
  notify: (message: string, tone?: 'normal' | 'error') => void;
}) => {
  const [now, setNow] = useState(Date.now());
  const running = !['completed', 'failed', 'stopped'].includes(status.stage);
  useEffect(() => {
    if (!running) return;
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, [running, status.operationId]);
  const elapsedMs = semanticPlanningElapsedMs(status, now);
  const longWait = status.stage === 'requesting' && elapsedMs >= 120_000;
  const diagnostic = JSON.stringify({ ...status, elapsedMs }, null, 2);
  return <>
    <span>{semanticPlanningStatusText(status, now)}</span>
    <button type="button" className="btn small ghost" style={{ marginLeft: 8 }}
      onClick={() => void copyText(diagnostic).then((copied) => notify(
        copied ? '已复制本次分段诊断。' : '复制失败，请重试。', copied ? undefined : 'error',
      )).catch(() => notify('复制失败，请重试。', 'error'))}>复制诊断</button>
    {longWait && <small style={{ display: 'block' }}>接口尚未返回完整结果，等待时间较长；可使用“停止分段”，已有方案保留。</small>}
    {status.stage === 'repairing' && status.detail && <small style={{ display: 'block' }}>{status.detail}</small>}
  </>;
};
