import { useMemo, useRef, useState } from 'react';
import { Cloud, ExternalLink, FolderOpen } from 'lucide-react';
import type { RunningHubVideoConfig } from '../runningHubVideoTypes';
import { isRunningHubVideoWorkflowReady, setActiveRunningHubVideoWorkflow } from '../runningHubVideo';
import { RunningHubWorkflowManager } from './RunningHubWorkflowManager';
import '../runningHubVideoSettings.css';

export const RUNNINGHUB_INVITATION_URL = 'https://www.runninghub.ai?inviteCode=e19djpw0';

export interface RunningHubVideoSettingsProps {
  config: RunningHubVideoConfig;
  getCurrentConfig?: () => RunningHubVideoConfig;
  onChange: (next: RunningHubVideoConfig) => void;
}

/** Connection settings are intentionally separate from both local ComfyUI and generic video APIs. */
export function RunningHubVideoSettings({ config, getCurrentConfig, onChange }: RunningHubVideoSettingsProps) {
  const [managerOpen, setManagerOpen] = useState(false);
  const [error, setError] = useState('');
  const [customRegion, setCustomRegion] = useState(false);
  const latest = useRef({ config, getCurrentConfig, onChange });
  latest.current = { config, getCurrentConfig, onChange };
  const currentConfig = () => latest.current.getCurrentConfig?.() || latest.current.config;
  const apply = (next: RunningHubVideoConfig) => {
    latest.current.config = next; latest.current.onChange(next); setError('');
  };
  const patch = (changes: Partial<RunningHubVideoConfig>) => apply({ ...currentConfig(), ...changes });
  const readiness = useMemo(() => new Map(config.workflows.map((workflow) => [workflow.id, isRunningHubVideoWorkflowReady(workflow)])), [config.workflows]);
  const active = config.workflows.find((workflow) => workflow.id === config.activeWorkflowId);
  const region = customRegion ? 'custom' : config.baseUrl.replace(/\/+$/u, '') === 'https://www.runninghub.cn' ? 'cn'
    : config.baseUrl.replace(/\/+$/u, '') === 'https://www.runninghub.ai' ? 'global' : 'custom';
  return <div className="vgs-main runninghub-video-settings" data-runninghub-video-settings="true">
    <section className="vgs-card">
      <div className="vgs-card-title rhv-connection-title">
        <div className="rhv-connection-heading">
          <h3><Cloud size={16} /> RunningHub 云端连接</h3>
          <a className="btn small rhv-invite-link" href={RUNNINGHUB_INVITATION_URL} target="_blank" rel="noopener noreferrer"
            aria-label="通过邀请链接注册 RunningHub" title={`${RUNNINGHUB_INVITATION_URL}\n赠币活动以 RunningHub 页面规则为准。`}
            onClick={async (event) => {
              const openExternal = typeof window !== 'undefined' ? window.lianhuaDesktop?.openExternal : undefined;
              if (typeof openExternal !== 'function') return;
              event.preventDefault();
              try { await openExternal(RUNNINGHUB_INVITATION_URL); }
              catch { setError('无法打开 RunningHub 邀请链接，请复制链接地址后在浏览器访问。'); }
            }}><ExternalLink size={14} aria-hidden="true" />邀请注册 · 领 1000 RH 币</a>
        </div>
        <label className="rhv-enable"><input type="checkbox" aria-label="启用 RunningHub 云端视频" checked={config.enabled} onChange={(event) => patch({ enabled: event.target.checked })} />启用云端视频</label>
      </div>
      <div className="vgs-fields rhv-connection-fields">
        <label className="field"><span>服务地区</span><select aria-label="RunningHub 服务地区" value={region} onChange={(event) => {
          setCustomRegion(event.target.value === 'custom');
          if (event.target.value === 'cn') patch({ baseUrl: 'https://www.runninghub.cn' });
          else if (event.target.value === 'global') patch({ baseUrl: 'https://www.runninghub.ai' });
        }}><option value="global">国际站 · runninghub.ai</option><option value="cn">国内站 · runninghub.cn</option><option value="custom">自定义地址</option></select></label>
        <label className="field"><span>API 根地址</span><input aria-label="RunningHub API 根地址" type="url" value={config.baseUrl} placeholder="https://www.runninghub.ai" onChange={(event) => patch({ baseUrl: event.target.value })} /></label>
        <label className="field"><span>RunningHub API Key</span><input aria-label="RunningHub API Key" type="password" autoComplete="off" spellCheck={false} value={config.apiKey} placeholder="仅在这里填写，不要粘贴到工作流 JSON" onChange={(event) => patch({ apiKey: event.target.value })} /></label>
      </div>
      <p className="vgs-workflow-help">地区请与账号及 API Key 对应。这里仅保存配置；生成时才上传参考图、提交任务并下载视频，不调用本地 ComfyUI。</p>
    </section>
    <section className="vgs-card">
      <div className="vgs-card-title"><h3>RunningHub 云端工作流库</h3><span>{config.workflows.length} 个已保存</span></div>
      <div className="vgs-workflow-row"><label className="field"><span>当前 RunningHub 工作流</span><select aria-label="当前 RunningHub 工作流" value={active?.id || ''} onChange={(event) => {
        try { apply(setActiveRunningHubVideoWorkflow(currentConfig(), event.target.value || null)); }
        catch (cause) { setError(cause instanceof Error ? cause.message : '工作流尚未配置完成。'); }
      }}><option value="">未选择工作流</option>{config.workflows.map((workflow) => <option key={workflow.id} value={workflow.id} disabled={!readiness.get(workflow.id)}>{workflow.name}{readiness.get(workflow.id) ? '' : ' · 待配置'}</option>)}</select></label><button type="button" className="btn" onClick={() => setManagerOpen(true)}><FolderOpen size={16} />管理云端工作流</button></div>
      <div className="vgs-workflow-summary"><strong>当前实际生效：</strong><span>{active?.name || '尚未选择'}</span>{active && <span className="vgs-summary-tags">{active.runKind === 'ai-app' ? 'AI 应用' : 'ComfyUI 工作流'} · 提示词 {active.mapping.prompt.length} 个 · 图片槽 {active.mapping.images.length} 个</span>}</div>
      <p className="vgs-workflow-help">可保存多份 AI 应用或云端 ComfyUI 工作流，分别保留 ID、节点映射、原始参数及运行选项。支持粘贴教程 cURL 或导入请求 JSON；导入只新增，不覆盖原工作流。</p>
    </section>
    <p className={`rhv-main-note${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>{error || '在管理页核对提示词输入，图片槽会全部列出，这里只维护槽位数量、顺序和节点字段；用途请在“生成视频 → 选择参考图”中按分段设置。每段不必选满，未用槽明确清空；其他常量、音频、LoRA 等字段保留。保存配置不产生云端费用。'}</p>
    {managerOpen && <RunningHubWorkflowManager config={config} getCurrentConfig={currentConfig} onChange={apply} onClose={() => setManagerOpen(false)} />}
  </div>;
}
