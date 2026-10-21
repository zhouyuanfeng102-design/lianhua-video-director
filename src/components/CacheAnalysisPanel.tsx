import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { BarChart3, ChevronLeft, ChevronRight, X } from 'lucide-react';
import {
  getTextApiCacheRate, loadTextApiUsageHistory, summarizeTextApiUsage,
  textApiStageLabel, textApiUsageStore, type TextApiUsageRecord,
} from '../textApiUsage';
import '../cacheAnalysis.css';

const HISTORY_LIMIT = 1000;
const PAGE_SIZE = 50;
const EMPTY_RECORDS: readonly TextApiUsageRecord[] = [];
const subscribe = (listener: () => void) => textApiUsageStore.subscribe(listener);
const readRecords = () => textApiUsageStore.getSnapshot();
const numberFormatter = new Intl.NumberFormat('zh-CN');
const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const formatNumber = (value?: number) => value === undefined ? '—' : numberFormatter.format(value);
const formatRate = (value?: number) => value === undefined ? '未返回' : `${(value * 100).toFixed(1)}%`;
const formatDuration = (value?: number) => value === undefined ? '—'
  : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} 秒`;
const statusLabels: Record<TextApiUsageRecord['status'], string> = {
  running: '请求中', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断',
};

function latestRecord(records: readonly TextApiUsageRecord[], projectId?: string) {
  let latest: TextApiUsageRecord | undefined;
  for (const record of records) {
    if (projectId && record.projectId !== projectId) continue;
    if (!latest || record.startedAt > latest.startedAt) latest = record;
  }
  return latest;
}

/** Only this small readout subscribes while the dialog is closed. */
function LatestCacheRate({ projectId }: { projectId?: string }) {
  const getLatest = useCallback(() => latestRecord(readRecords(), projectId), [projectId]);
  const record = useSyncExternalStore(subscribe, getLatest, () => undefined);
  const rate = record ? getTextApiCacheRate(record) : undefined;
  const label = !record || record.status === 'running' || rate === undefined ? '—' : formatRate(rate);
  return <span className="cache-analysis-trigger-value" title={record
    ? `最近一次请求：${textApiStageLabel(record.stage)} · ${statusLabels[record.status]} · 命中率${formatRate(rate)}`
    : '当前项目暂无文字 API 请求记录'}>{label}</span>;
}

function RequestDetails({ record }: { record: TextApiUsageRecord }) {
  return <details className="cache-analysis-details">
    <summary aria-label={`查看${textApiStageLabel(record.stage)}请求的用量详情`}>详情</summary>
    <dl>
      <div><dt>数字来源</dt><dd>{record.usageSource || '接口未返回用量字段'}</dd></div>
      <div><dt>输出 Token</dt><dd>{formatNumber(record.outputTokens)}</dd></div>
      <div><dt>缓存写入 Token</dt><dd>{formatNumber(record.cacheWriteTokens)}</dd></div>
      <div><dt>提供商</dt><dd>{record.provider || '未记录'}</dd></div>
      <div><dt>请求编号</dt><dd>{record.id}</dd></div>
      {record.operationId && <div><dt>所属操作</dt><dd>{record.operationId}</dd></div>}
    </dl>
  </details>;
}

function CacheAnalysisDialog({ projectId, onClose, triggerRef }: {
  projectId?: string;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement>;
}) {
  const records = useSyncExternalStore(subscribe, readRecords, () => EMPTY_RECORDS);
  const [projectFilter, setProjectFilter] = useState(projectId ? `project:${projectId}` : 'all');
  const [modelFilter, setModelFilter] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [page, setPage] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const recent = useMemo(() => [...records].sort((a, b) => b.startedAt - a.startedAt).slice(0, HISTORY_LIMIT), [records]);
  const projects = useMemo(() => {
    const values = new Map<string, string>();
    if (projectId) values.set(projectId, '当前项目');
    for (const record of recent) {
      if (record.projectId && (!values.has(record.projectId) || values.get(record.projectId) === '当前项目')) {
        values.set(record.projectId, record.projectName || (record.projectId === projectId ? '当前项目' : record.projectId));
      }
    }
    return [...values];
  }, [recent, projectId]);
  const models = useMemo(() => [...new Set(recent.map((record) => record.model))].filter(Boolean).sort(), [recent]);
  const stages = useMemo(() => [...new Set(recent.map((record) => record.stage))].sort(), [recent]);
  const filtered = useMemo(() => recent.filter((record) => (
    (projectFilter === 'all' || (projectFilter === 'unassigned' ? !record.projectId : `project:${record.projectId}` === projectFilter))
    && (!modelFilter || record.model === modelFilter)
    && (!stageFilter || record.stage === stageFilter)
  )), [recent, projectFilter, modelFilter, stageFilter]);
  const summary = useMemo(() => summarizeTextApiUsage(filtered), [filtered]);
  const latest = filtered[0];
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && triggerRef.current) dialog.style.setProperty('--ui-font-scale', getComputedStyle(triggerRef.current).getPropertyValue('--ui-font-scale') || '1');
    dialog?.showModal();
    closeRef.current?.focus();
    return () => {
      dialog?.close();
      triggerRef.current?.focus();
    };
  }, [triggerRef]);

  return createPortal(<dialog ref={dialogRef} className="cache-analysis-dialog" role="dialog" aria-modal="true"
    aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
      )].filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <header className="cache-analysis-header">
      <div><h2 id={titleId}><BarChart3 size={19} aria-hidden="true" />缓存命中分析</h2>
        <p id={descriptionId}>查看最近 {HISTORY_LIMIT} 次文字 API 请求，数据来自每次接口响应。</p></div>
      <button ref={closeRef} type="button" className="cache-analysis-close" onClick={onClose} aria-label="关闭缓存命中分析"><X size={19} /></button>
    </header>
    <div className="cache-analysis-content">
      <div className="cache-analysis-filters">
        <label>项目<select value={projectFilter} onChange={(event) => { setProjectFilter(event.target.value); setPage(0); }}>
          <option value="all">全部项目</option>
          {projects.map(([id, name]) => <option key={id} value={`project:${id}`}>{name}{id === projectId && name !== '当前项目' ? '（当前）' : ''}</option>)}
          <option value="unassigned">未归属项目</option>
        </select></label>
        <label>模型<select value={modelFilter} onChange={(event) => { setModelFilter(event.target.value); setPage(0); }}>
          <option value="">全部模型</option>
          {models.map((model) => <option key={model} value={model}>{model}</option>)}
        </select></label>
        <label>任务阶段<select value={stageFilter} onChange={(event) => { setStageFilter(event.target.value); setPage(0); }}>
          <option value="">全部阶段</option>
          {stages.map((stage) => <option key={stage} value={stage}>{textApiStageLabel(stage)}</option>)}
        </select></label>
      </div>
      <div className="cache-analysis-summary" aria-label="当前筛选范围的汇总">
        <div><span>请求总数</span><strong>{formatNumber(summary.total)}</strong><small>含进行中、失败与取消</small></div>
        <div><span>有命中率数据</span><strong>{formatNumber(summary.measured)}<em> / {formatNumber(summary.total)}</em></strong><small>缺失数据不计作零命中</small></div>
        <div><span>累计命中率</span><strong>{formatRate(summary.rate)}</strong><small>按输入 Token 加权</small></div>
        <div><span>最近一次请求</span><strong>{latest?.status === 'running' ? '请求中' : latest ? formatRate(getTextApiCacheRate(latest)) : '暂无'}</strong>
          <small>{latest ? textApiStageLabel(latest.stage) : '等待文字 API 请求'}</small></div>
      </div>
      <p className="cache-analysis-note">可计算请求合计：输入 {formatNumber(summary.inputTokens)} · 命中 {formatNumber(summary.hitTokens)} · 未命中 {formatNumber(summary.missTokens)} Token。接口未提供完整用量时显示“未返回”。</p>
      <div className="cache-analysis-table-scroll" tabIndex={0} aria-label="请求记录，可横向滚动">
        <table className="cache-analysis-table">
          <caption className="cache-analysis-visually-hidden">文字 API 请求缓存用量，最新请求在前，Token 数值均来自接口用量。</caption>
          <thead><tr><th scope="col">时间</th><th scope="col">归属</th><th scope="col">任务</th><th scope="col">接口 / 模型</th>
            <th scope="col">输入</th><th scope="col">命中 / 未命中</th><th scope="col">命中率</th><th scope="col">耗时 / 状态</th><th scope="col">用量</th></tr></thead>
          <tbody>{visible.map((record) => <tr key={record.id}>
            <td className="cache-analysis-time">{timeFormatter.format(record.startedAt)}</td>
            <td><span>{record.projectName || (record.projectId === projectId ? '当前项目' : record.projectId ? '未命名项目' : '未归属项目')}</span>
              {(record.chapterName || record.chapterId || record.segmentIndex !== undefined) && <small>
                {record.chapterName || (record.chapterId ? '章节已记录' : '')}{record.segmentIndex !== undefined ? ` · 第 ${record.segmentIndex} 段` : ''}
              </small>}</td>
            <td>{textApiStageLabel(record.stage)}</td>
            <td className="cache-analysis-model"><span>{record.model || '未记录'}</span><small>{record.connectionName || record.provider}</small></td>
            <td className="cache-analysis-number">{formatNumber(record.inputTokens)}</td>
            <td className="cache-analysis-number">{formatNumber(record.cacheHitTokens)}<small>/ {formatNumber(record.cacheMissTokens)}</small></td>
            <td className="cache-analysis-number">{formatRate(getTextApiCacheRate(record))}</td>
            <td><span className={`cache-analysis-status cache-analysis-status-${record.status}`}>{statusLabels[record.status]}</span><small>{formatDuration(record.durationMs)}</small></td>
            <td><RequestDetails record={record} /></td>
          </tr>)}
          {!visible.length && <tr><td colSpan={9} className="cache-analysis-empty">{recent.length ? '当前筛选范围暂无请求记录。' : '暂无文字 API 请求记录。正常使用文字生成功能后，用量会自动显示在这里。'}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
    <footer className="cache-analysis-footer">
      <span>{filtered.length ? `${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)}` : '0'} / {filtered.length} 条 · 每页 {PAGE_SIZE} 条</span>
      <nav aria-label="请求记录分页">
        <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} aria-label="上一页"><ChevronLeft size={16} />上一页</button>
        <span aria-live="polite">{currentPage + 1} / {pageCount}</span>
        <button type="button" disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)} aria-label="下一页">下一页<ChevronRight size={16} /></button>
      </nav>
    </footer>
  </dialog>, document.body);
}

export function CacheAnalysisPanel({ projectId }: { projectId?: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => { loadTextApiUsageHistory(); }, []);
  return <>
    <button ref={triggerRef} type="button" className="update-log-trigger cache-analysis-trigger"
      onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>
      <BarChart3 aria-hidden="true" /><span>缓存命中分析</span><LatestCacheRate projectId={projectId} />
    </button>
    {open && <CacheAnalysisDialog key={projectId || 'all'} projectId={projectId} onClose={close} triggerRef={triggerRef} />}
  </>;
}
