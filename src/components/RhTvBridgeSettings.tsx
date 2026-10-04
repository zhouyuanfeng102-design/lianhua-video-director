import { useEffect, useRef, useState } from 'react';
import { ExternalLink, FolderOpen, LogIn, Play, RefreshCw, Square, Upload, X } from 'lucide-react';
import type { VideoTaskApiConfig } from '../types';
import { rhtvModes, type RhTvBridgeStatus, type RhTvControlRequest, type RhTvMode } from '../rhtvBridge';
import { formatUserFacingError } from '../userFacingError';

export function RhTvBridgeSettings({ config, onChange }: { config: VideoTaskApiConfig; onChange: (patch: Partial<VideoTaskApiConfig>) => void }) {
  const [status, setStatus] = useState<RhTvBridgeStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const desktop = window.lianhuaDesktop?.rhtvControl;
  useEffect(() => {
    let active = true;
    const read = async () => { try { const result = await desktop?.({ action: 'status' }); if (active && result) setStatus(result); } catch (cause) { if (active) setError(formatUserFacingError(cause)); } };
    void read(); const timer = window.setInterval(() => { if (!busy) void read(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [desktop, busy]);
  const run = async (request: RhTvControlRequest) => {
    if (!desktop || inFlight.current) return;
    if (request.action === 'automation' && request.enabled && !window.confirm('启用后，当前待提交及后续 rhTV 任务的提示词、所选原图将自动上传到 rhTV，并在每次确认 H3 报价为零后提交生成、下载成片。请确认素材使用权及账号自动化使用权限。登录失效、收费、引用不符时暂停；已发出的任务不会因关闭开关而取消。启用吗？')) return;
    if (request.action === 'prepare' && !window.confirm('将此任务的原提示词和已选图片上传到 rhTV 网页。请确认拥有素材使用权且平台允许此操作。程序不会点击生成；请在网页核对附件引用、参数及费用。继续吗？')) return;
    if (request.action === 'import-result' && !window.confirm('请仅选择这个原任务生成的视频。导入后将确认此任务结束，并允许后续任务继续。')) return;
    if (request.action === 'confirm-not-submitted' && !window.confirm('请先在 rhTV 网页确认此任务确实没有提交、没有排队和扣费。确认后将关闭原标签页并释放队列占位。已经提交的任务不要使用此操作。确认未提交吗？')) return;
    if (request.action === 'confirm-ended' && !window.confirm('请先在原 rhTV 网页核实此任务已明确失败或取消。关闭网页、停止查询、暂时看不到任务都不算结束。本操作关闭原标签页并释放本机占位，不会取消云端任务或申请退款。确认已结束吗？')) return;
    inFlight.current = true; setBusy(true); setError('');
    try { const result = await desktop(request); if (mounted.current) setStatus(result); }
    catch (cause) { if (mounted.current) setError(formatUserFacingError(cause)); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  return <div className="rhtv-settings">
    <div className="vgs-fields vgs-fields-three">
      <div className="field"><span>网页模型</span><output className="rhtv-readonly">Minimax H3 RH Enhanced</output></div>
      <label className="field"><span>rhTV 默认模式</span><select aria-label="rhTV 默认模式" value={config.rhtvMode || 'reference'} onChange={(event) => onChange({ rhtvMode: event.target.value as RhTvMode })}>{Object.entries(rhtvModes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="field"><span>rhTV 默认时长（秒）</span><input aria-label="rhTV 默认时长" type="number" min={4} max={15} step={1} value={config.rhtvDuration ?? 5} onChange={(event) => onChange({ rhtvDuration: Number(event.target.value) })} /></label>
      <label className="field"><span>rhTV 默认分辨率</span><select aria-label="rhTV 默认分辨率" value={config.rhtvResolution || '768p'} onChange={(event) => onChange({ rhtvResolution: event.target.value })}>{['480p','768p','1080p'].map((item) => <option key={item}>{item}</option>)}</select></label>
      <label className="field"><span>rhTV 默认画面比例</span><select aria-label="rhTV 默认画面比例" value={config.rhtvAspectRatio || '自适应'} onChange={(event) => onChange({ rhtvAspectRatio: event.target.value })}>{['自适应','1:1','2:3','3:2','3:4','4:3','9:16','16:9','21:9'].map((item) => <option key={item}>{item}</option>)}</select></label>
      <div className="field"><span>费用策略</span><output className="rhtv-readonly">仅免费；费用未验证时不自动提交</output></div>
      <div className="field"><span>并发</span><output className="rhtv-readonly">单账号串行</output></div>
      <div className="field"><span>浏览器</span><output className="rhtv-readonly">Microsoft Edge · 独立登录目录</output></div>
      <label className="field"><span>自动执行</span><span className="rhtv-automation-toggle"><input type="checkbox" role="switch" aria-label="rhTV 零费用自动执行" checked={status?.automatic_submission === true} disabled={!desktop || busy} onChange={(event) => void run({ action: 'automation', enabled: event.target.checked })} />仅零费用自动提交</span></label>
    </div>
    <div className="vgs-actions">
      <button type="button" className="btn small" disabled={!desktop || busy || status?.running} onClick={() => void run({ action: 'start' })}><Play size={14} />启动桥接</button>
      <button type="button" className="btn small" disabled={!desktop || busy} onClick={() => void run({ action: 'login' })}><LogIn size={14} />Edge 登录 rhTV</button>
      <button type="button" className="btn small" disabled={!desktop || busy} onClick={() => void run({ action: 'status' })}><RefreshCw size={14} />检查连接</button>
      <button type="button" className="btn small" disabled={!status?.running || busy} onClick={() => void run({ action: 'stop' })}><Square size={14} />停止桥接</button>
    </div>
    <p role="status">{!desktop ? '仅桌面程序支持 rhTV 网页桥接' : status ? `${status.running ? '桥接运行中' : '桥接未启动'} · ${status.browser}` : '正在读取连接状态'}</p>
    <p className="vgs-provider-note">{status?.message || '自动执行未启用'}{status?.live_site_verified === false ? ' · 实站联调待验收' : ''}</p>
    {status?.endpoint && <p>本机服务：{status.endpoint}</p>}
    {error && <p className="vd-error" role="alert">{error}</p>}
    {status && status.jobs.length > 0 && <div className="rhtv-jobs">
      <h4>rhTV 桥接任务</h4>
      {status.jobs.slice(0, 30).map((job) => <article className="rhtv-job" key={job.id}>
        <strong>{rhtvModes[job.mode]} · {job.reference_count} 张图 · {new Date(job.created_at).toLocaleString('zh-CN')}</strong>
        <p>{job.message}</p><small>{job.client_id}</small>
        {job.upstream_task_id && <p>网页任务：{job.upstream_task_id}</p>}
        {job.quote && <p>提交前报价：{job.quote.total} {job.quote.currency} · {new Date(job.quote.checked_at).toLocaleTimeString('zh-CN')}</p>}
        {job.references.length > 0 && <ul>{job.references.map((ref) => <li key={ref.slot_index}>槽 {ref.slot_index + 1} · {ref.role} · {ref.asset_id}{ref.character_ids?.length ? ` · 人物 ${ref.character_ids.join('、')}` : ''}</li>)}</ul>}
        {!['succeeded','cancelled','failed'].includes(job.status) && <div className="vgs-actions">
          <button type="button" className="btn small" disabled={busy} onClick={() => void run({ action: 'materials', jobId: job.id })}><FolderOpen size={14} />本机素材目录</button>
          <button type="button" className="btn small" disabled={busy || !job.handed_off && status.automatic_submission} onClick={() => void run({ action: job.handed_off ? 'handoff' : 'prepare', jobId: job.id })}><ExternalLink size={14} />{job.handed_off ? '查看原网页' : '人工准备网页'}</button>
          {job.automatic && (job.upstream_task_id || !job.submission_started && job.status === 'paused') && <button type="button" className="btn small" disabled={busy || ['preparing','submitting','downloading'].includes(job.status)} onClick={() => void run({ action: 'retry', jobId: job.id })}><RefreshCw size={14} />{job.upstream_task_id ? '继续原任务查询/下载' : '重新核验并继续'}</button>}
          <button type="button" className="btn small" disabled={busy || !job.handed_off} onClick={() => void run({ action: 'import-result', jobId: job.id })}><Upload size={14} />导入原任务成片</button>
          <button type="button" className="btn small" disabled={busy || job.handed_off && (!job.automatic || job.submission_started)} onClick={() => void run({ action: 'cancel', jobId: job.id })}><X size={14} />取消待提交任务</button>
          {job.handed_off && !job.upstream_task_id && <button type="button" className="btn small" disabled={busy || ['preparing','submitting'].includes(job.status)} onClick={() => void run({ action: 'confirm-not-submitted', jobId: job.id })}><X size={14} />核实未提交并取消</button>}
          {job.handed_off && <button type="button" className="btn small" disabled={busy} onClick={() => void run({ action: 'confirm-ended', jobId: job.id })}><Square size={14} />核实网页已失败/取消</button>}
        </div>}
      </article>)}
    </div>}
  </div>;
}
