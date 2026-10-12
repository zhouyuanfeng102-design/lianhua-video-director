import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import type { ImageApiConfig } from '../types';
import type { RunningHubVideoConfig } from '../runningHubVideoTypes';
import { importRunningHubImageWorkflow, isRunningHubImageWorkflowReady, normalizeRunningHubImageConfig, validateRunningHubImageConfig, validateRunningHubImageWorkflow } from '../runningHubImage';
import { RunningHubWorkflowManager } from './RunningHubWorkflowManager';

interface Props { config: ImageApiConfig; onChange: (patch: Partial<ImageApiConfig>) => void }

/** Image applications use RunningHub nodeInfoList requests, independently of
 * local ComfyUI API graphs. Importing/configuring never submits a task. */
export function RunningHubImageSettings({ config, onChange }: Props) {
  const [managerOpen, setManagerOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const latest = useRef({ config, onChange }); latest.current = { config, onChange };
  const normalized = useMemo(() => normalizeRunningHubImageConfig(config), [config]);
  const workflows = normalized.runningHubWorkflows;
  const active = workflows.find((workflow) => workflow.id === normalized.activeRunningHubWorkflowId);
  const issue = config.enabled ? validateRunningHubImageConfig(config) : undefined;
  const managerConfig = (): RunningHubVideoConfig => {
    const value = latest.current.config;
    const saved = normalizeRunningHubImageConfig(value);
    return { enabled: value.enabled, baseUrl: value.baseUrl, apiKey: value.apiKey, workflows: saved.runningHubWorkflows, activeWorkflowId: saved.activeRunningHubWorkflowId };
  };
  const applyManager = (next: RunningHubVideoConfig) => latest.current.onChange({
    runningHubWorkflows: next.workflows, activeRunningHubWorkflowId: next.activeWorkflowId, enabled: next.enabled,
  });
  const importRequest = (source: string, name?: string) => {
    setError(''); setMessage('');
    try {
      const result = importRunningHubImageWorkflow(source, name);
      const current = normalizeRunningHubImageConfig(latest.current.config);
      const next = [...current.runningHubWorkflows, result.workflow];
      const activeId = current.activeRunningHubWorkflowId || (isRunningHubImageWorkflowReady(result.workflow) ? result.workflow.id : null);
      latest.current.onChange({ runningHubWorkflows: next, activeRunningHubWorkflowId: activeId,
        ...(result.baseUrl && !current.activeRunningHubWorkflowId ? { baseUrl: result.baseUrl } : {}) });
      setImportText('');
      setMessage(`已导入 ${result.workflow.name}：提示词 ${result.workflow.mapping.prompt.length} 个，宽度 ${result.workflow.mapping.parameters?.width ? 1 : 0} 个，高度 ${result.workflow.mapping.parameters?.height ? 1 : 0} 个。仅保存配置，未提交云端任务。${result.warnings.length ? ` ${result.warnings.join(' ')}` : ''}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'RunningHub 图片应用导入失败。'); }
  };
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setReading(true);
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('请求资料超过 8 MB，请导入 API 请求 JSON 或说明文本。');
      importRequest(await file.text(), file.name.replace(/\.(json|md|markdown|txt)$/iu, ''));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法读取导入文件。'); }
    finally { setReading(false); }
  };
  return <div className="comfyui-settings runninghub-image-settings" data-runninghub-image-settings="true">
    <label className="field"><span>当前 RunningHub 图片应用</span><select aria-label="当前 RunningHub 图片应用" value={active?.id || ''}
      onChange={(event) => onChange({ activeRunningHubWorkflowId: event.target.value || null })}>
      <option value="">请选择云端图片应用</option>{workflows.map((workflow) => <option key={workflow.id} value={workflow.id} disabled={!isRunningHubImageWorkflowReady(workflow)}>{workflow.name}{isRunningHubImageWorkflowReady(workflow) ? '' : ' · 待配置'}</option>)}
    </select></label>
    <div className="row wrap"><button type="button" className="btn small" disabled={reading} onClick={() => fileRef.current?.click()}>{reading ? '读取中…' : '导入 API 请求文件'}</button>
      <button type="button" className="btn small" onClick={() => setManagerOpen(true)}>管理图片应用与节点映射</button></div>
    <input ref={fileRef} className="file-input" type="file" accept=".json,.md,.markdown,.txt,application/json,text/plain,text/markdown" onChange={importFile} />
    <details><summary>粘贴 RunningHub API 资料导入</summary><label className="field"><span>cURL、请求 JSON 或完整 Markdown 资料</span><textarea aria-label="RunningHub 图片导入文本" rows={5} value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="粘贴 RunningHub API 调用资料，包含应用 ID 与 nodeInfoList。" /></label>
      <button type="button" className="btn small" disabled={!importText.trim() || reading} onClick={() => importRequest(importText)}>导入图片应用</button></details>
    <div className="hint-box"><strong>当前实际生效：</strong>{active ? `${active.name} · ${active.runKind === 'ai-app' ? 'AI 应用' : '云端工作流'} ${active.remoteId}` : '尚未选择'}
      {active && <div>提示词 {active.mapping.prompt.length} 个 · 宽度 {active.mapping.parameters?.width ? '已映射' : '使用云端原值'} · 高度 {active.mapping.parameters?.height ? '已映射' : '使用云端原值'}</div>}</div>
    <p className="field-hint">RunningHub 云端图片使用应用请求与 API Key；本地 ComfyUI 图请在 ComfyUI 后端导入。{active?.mapping.images.length ? `当前工作流可上传 ${active.mapping.images.length} 张参考图，按明确的图片槽映射提交。` : '当前应用没有参考图片槽，仅支持文生图；已选参考图会明确阻止提交，不会静默丢图。'}采样与模型参数保持云端工作流原值。</p>
    {message && <div className="field-hint" role="status">{message}</div>}
    {(error || issue) && <div className="field-hint" role="alert">{error || issue}</div>}
    {managerOpen && <RunningHubWorkflowManager mediaKind="image" importWorkflow={importRunningHubImageWorkflow} isWorkflowReady={isRunningHubImageWorkflowReady} validateWorkflow={validateRunningHubImageWorkflow} config={managerConfig()} getCurrentConfig={managerConfig} onChange={applyManager} onClose={() => setManagerOpen(false)} />}
  </div>;
}
