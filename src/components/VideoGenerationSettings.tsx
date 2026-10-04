import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Copy, Film, FolderOpen, Save, Settings2, Trash2, Upload, X } from 'lucide-react';
import { formatUserFacingError } from '../userFacingError';
import { importComfyVideoWorkflow } from '../comfyuiVideo';
import { assertNoEmbeddedVideoCredentials, defaultRunningHubVideoApi, videoApiSubmitEndpoint } from '../videoGenerationApi';
import { VideoWorkflowManager } from './VideoWorkflowManager';
import { RunningHubVideoSettings } from './RunningHubVideoSettings';
import { RhTvBridgeSettings } from './RhTvBridgeSettings';
import { defaultRhTvApi } from '../rhtvBridge';
import { defaultRunningHubVideoConfig } from '../runningHubVideo';
import type { VideoGenerationSource } from '../videoGenerationTypes';
import { isVideoWorkflowReady, uniqueVideoWorkflowName } from '../videoWorkflowLibrary';
import type { AppSettings, VideoTaskApiConfig } from '../types';
import { defaultComfyVideoConfig, type ComfyVideoConfig, type VideoApiProfile } from '../videoGenerationTypes';
import '../videoDirector.css';
import '../videoGenerationSettings.css';

export interface VideoGenerationSettingsProps {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  getCurrentSettings?: () => AppSettings;
  allowPrivateNetwork?: boolean;
  onPrivateNetworkChange?: (allowed: boolean) => void;
}
const idFor = (prefix: string) => `${prefix}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const parseSettingsJson = (source: string): unknown => {
  try { return JSON.parse(source); }
  catch { throw new Error('JSON 格式无法读取，请检查逗号、引号和括号；现有配置未被覆盖。'); }
};

export function VideoGenerationSettings({ settings, onChange, getCurrentSettings, allowPrivateNetwork, onPrivateNetworkChange }: VideoGenerationSettingsProps) {
  const [panel, setPanel] = useState<VideoGenerationSource>(settings.videoSource || settings.videoBackend || 'api');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [managerOpen, setManagerOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedTab, setAdvancedTab] = useState<'request' | 'response' | 'media'>('request');
  const [templateText, setTemplateText] = useState('');
  const [templateBaseline, setTemplateBaseline] = useState('');
  const [templateProfile, setTemplateProfile] = useState<string | null | undefined>();
  const [templateError, setTemplateError] = useState('');
  const [profileName, setProfileName] = useState('');
  const [importing, setImporting] = useState(false);
  const [pathMode, setPathMode] = useState<'standard' | 'custom'>(settings.comfyuiVideo?.promptPath && settings.comfyuiVideo.promptPath !== '/prompt' ? 'custom' : 'standard');
  const inputRef = useRef<HTMLInputElement>(null);
  const advancedDialogRef = useRef<HTMLElement>(null);
  const mounted = useRef(true);
  const importEpoch = useRef(0);
  const latest = useRef({ settings, onChange, getCurrentSettings }); latest.current = { settings, onChange, getCurrentSettings };
  const currentSettings = () => latest.current.getCurrentSettings?.() || latest.current.settings;
  const update = (make: (current: AppSettings) => Partial<AppSettings>) => {
    const current = currentSettings(); const patch = make(current);
    latest.current.settings = { ...current, ...patch }; latest.current.onChange(patch);
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; importEpoch.current += 1; }; }, []);
  const api = settings.videoTaskApi;
  const profiles = settings.videoApiProfiles || [];
  const comfy = settings.comfyuiVideo || defaultComfyVideoConfig;
  const workflowReadiness = useMemo(() => new Map(comfy.workflows.map((workflow) => [workflow.id, isVideoWorkflowReady(workflow)])), [comfy.workflows]);
  const active = comfy.workflows.find((workflow) => workflow.id === comfy.activeWorkflowId)
    || (comfy.activeWorkflowId === undefined ? comfy.workflows.find((workflow) => workflowReadiness.get(workflow.id)) : undefined);
  const selectedProfile = profiles.find((profile) => profile.id === settings.activeVideoApiProfileId);
  useEffect(() => setProfileName(selectedProfile?.name || ''), [selectedProfile?.id, selectedProfile?.name]);
  useEffect(() => { if (comfy.promptPath && comfy.promptPath !== '/prompt') setPathMode('custom'); }, [comfy.promptPath]);
  const patchApi = (patch: Partial<VideoTaskApiConfig>) => update((current) => {
    const next = { ...current.videoTaskApi, ...patch };
    return { videoTaskApi: next, videoApiProfiles: (current.videoApiProfiles || []).map((profile) => profile.id === current.activeVideoApiProfileId ? { ...profile, ...next, updatedAt: Date.now() } : profile) };
  });
  const patchComfy = (patch: Partial<ComfyVideoConfig>) => update((current) => ({ comfyuiVideo: { ...(current.comfyuiVideo || defaultComfyVideoConfig), ...patch } }));
  const selectProfile = (id: string) => update((current) => {
    const profile = current.videoApiProfiles?.find((item) => item.id === id);
    if (!profile) return { activeVideoApiProfileId: null };
    const { id: _id, name: _name, createdAt: _createdAt, updatedAt: _updatedAt, ...config } = profile;
    return { videoTaskApi: structuredClone(config), activeVideoApiProfileId: id };
  });
  const saveProfile = (asNew: boolean) => {
    update((current) => {
      const old = current.videoApiProfiles?.find((profile) => profile.id === current.activeVideoApiProfileId);
      const now = Date.now();
      const entry: VideoApiProfile = { ...structuredClone(current.videoTaskApi), id: !asNew && old ? old.id : idFor('video-api'),
        name: profileName.trim() || old?.name || `视频接口 ${(current.videoApiProfiles?.length || 0) + 1}`, createdAt: !asNew && old ? old.createdAt : now, updatedAt: now };
      return { videoApiProfiles: !asNew && old ? current.videoApiProfiles!.map((profile) => profile.id === old.id ? entry : profile) : [...(current.videoApiProfiles || []), entry], activeVideoApiProfileId: entry.id };
    });
    setError(''); setMessage(asNew ? '已另存为新的视频连接，原连接保留。' : '视频连接已更新到设置。');
  };
  const deleteProfile = () => {
    if (!selectedProfile || !window.confirm(`删除连接“${selectedProfile.name}”？当前参数及已提交任务保留。`)) return;
    const id = selectedProfile.id;
    update((current) => ({ videoApiProfiles: (current.videoApiProfiles || []).filter((profile) => profile.id !== id), activeVideoApiProfileId: current.activeVideoApiProfileId === id ? null : current.activeVideoApiProfileId }));
    setMessage('连接条目已删除，当前参数未清空。');
  };
  const applyRunningHubPreset = () => {
    const current = currentSettings().videoTaskApi;
    patchApi({ ...defaultRunningHubVideoApi, apiKey: current.apiKey, runningHubAppId: current.runningHubAppId || '' });
    setError(''); setMessage('已填入 RunningHub 协议，请核对应用 ID、密钥和请求模板中的实际节点 ID。');
  };
  const addRhTvProfile = () => {
    update((current) => {
      const now = Date.now();
      const profiles = [...(current.videoApiProfiles || [])];
      if (!profiles.some((item) => item.id === current.activeVideoApiProfileId)
        && (current.videoTaskApi.endpoint.trim() || current.videoTaskApi.apiKey.trim())) {
        profiles.push({ ...structuredClone(current.videoTaskApi), id: idFor('video-api'), name: profileName.trim() || '原视频接口', createdAt: now, updatedAt: now });
      }
      const entry: VideoApiProfile = { ...defaultRhTvApi, id: idFor('video-api'), name: 'rhTV H3 网页', createdAt: now, updatedAt: now };
      return { videoTaskApi: { ...defaultRhTvApi }, videoApiProfiles: [...profiles, entry], activeVideoApiProfileId: entry.id };
    });
    setProfileName('rhTV H3 网页'); setMessage('已新增 rhTV 专用连接，原连接保留。'); setError('');
  };
  const importWorkflow = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || importing) return;
    const epoch = ++importEpoch.current; setImporting(true); setMessage(''); setError('');
    try {
      const source = await file.text(); assertNoEmbeddedVideoCredentials(parseSettingsJson(source), '视频工作流');
      const imported = importComfyVideoWorkflow(source);
      if (!mounted.current || epoch !== importEpoch.current) return;
      const now = Date.now(); const workflow = { ...imported, id: idFor('video-workflow'), name: file.name.replace(/\.json$/iu, '') || '导入的视频工作流', createdAt: now, updatedAt: now };
      update((current) => { const connection = current.comfyuiVideo || defaultComfyVideoConfig;
        workflow.name = uniqueVideoWorkflowName(workflow.name, connection.workflows);
        return { comfyuiVideo: { ...connection, workflows: [...connection.workflows, workflow], activeWorkflowId: isVideoWorkflowReady(workflow) ? workflow.id : connection.activeWorkflowId } }; });
      setMessage(`已新增“${workflow.name}”，没有覆盖其它工作流。${isVideoWorkflowReady(workflow) ? '已设为当前。' : '请在管理面板补充映射后启用。'}`);
    } catch (cause) { if (mounted.current) setError(formatUserFacingError(cause)); }
    finally { if (mounted.current && epoch === importEpoch.current) setImporting(false); }
  };
  const openAdvanced = () => {
    const current = currentSettings(); const text = current.videoTaskApi.requestTemplate || '';
    setTemplateText(text); setTemplateBaseline(text); setTemplateProfile(current.activeVideoApiProfileId);
    setTemplateError(''); setAdvancedTab('request'); setAdvancedOpen(true);
  };
  const closeAdvanced = () => {
    if (templateText !== templateBaseline && !window.confirm('请求模板尚未保存，关闭并放弃模板编辑吗？其它连接字段会保留。')) return;
    setAdvancedOpen(false); setTemplateError('');
  };
  const closeRef = useRef(closeAdvanced); closeRef.current = closeAdvanced;
  useEffect(() => {
    if (!advancedOpen || typeof document === 'undefined') return;
    const previous = document.activeElement;
    advancedDialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key === 'Tab') {
        const fields = [...(advancedDialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)') || [])].filter((element) => element.getClientRects().length);
        const first = fields[0]; const last = fields[fields.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', close);
    return () => { window.removeEventListener('keydown', close); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [advancedOpen]);
  const saveTemplate = () => {
    try {
      const current = currentSettings();
      if (current.activeVideoApiProfileId !== templateProfile || (current.videoTaskApi.requestTemplate || '') !== templateBaseline) throw new Error('连接或模板已在其它位置改变，请关闭后重新打开，避免覆盖。');
      if (templateText.trim()) { const parsed = parseSettingsJson(templateText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求模板必须是 JSON 对象。');
        assertNoEmbeddedVideoCredentials(parsed, '视频 API 请求模板'); }
      patchApi({ requestTemplate: templateText }); setTemplateBaseline(templateText); setTemplateError(''); setMessage('请求模板已保存，尚未提交任何生成任务。');
    } catch (cause) { setTemplateError(formatUserFacingError(cause)); }
  };
  const apiField = (key: keyof VideoTaskApiConfig, label: string, placeholder = '', secret = false) => <label className="field" key={key}><span>{label}</span><input aria-label={label} type={secret ? 'password' : 'text'} value={String(api[key] || '')} placeholder={placeholder} onChange={(event) => patchApi({ [key]: event.target.value })} /></label>;
  const permission = onPrivateNetworkChange && <label className="check-row vgs-permission"><input type="checkbox" checked={Boolean(allowPrivateNetwork)} onChange={(event) => onPrivateNetworkChange(event.target.checked)} />允许访问本机与局域网模型端点</label>;

  return <section className="video-generation-settings video-settings-redesign" data-video-settings-panel={panel}>
    <header className="vgs-header"><div><h2><Film size={17} />视频生成连接</h2><p>常用连接放在这里，工作流与高级协议单独管理。</p></div><label className="field vgs-default"><span>默认生成方式</span><select aria-label="默认视频生成方式" value={settings.videoSource || settings.videoBackend || 'api'} onChange={(event) => update(() => ({ videoSource: event.target.value as VideoGenerationSource, videoBackend: event.target.value === 'comfyui' ? 'comfyui' : 'api' }))}><option value="api">视频 API</option><option value="comfyui">ComfyUI</option><option value="runninghub">RunningHub 云端</option></select></label></header>
    <div className="vgs-tabs" role="tablist" aria-label="视频生成连接类型"><button type="button" role="tab" className={`btn ${panel === 'api' ? 'primary' : ''}`} aria-selected={panel === 'api'} onClick={() => { setPanel('api'); setMessage(''); setError(''); }}>视频 API</button><button type="button" role="tab" className={`btn ${panel === 'comfyui' ? 'primary' : ''}`} aria-selected={panel === 'comfyui'} onClick={() => { setPanel('comfyui'); setMessage(''); setError(''); }}>ComfyUI 视频</button><button type="button" role="tab" className={`btn ${panel === 'runninghub' ? 'primary' : ''}`} aria-selected={panel === 'runninghub'} onClick={() => { setPanel('runninghub'); setMessage(''); setError(''); }}>RunningHub 云端</button><span>{panel === 'api' ? '保存不同服务的连接，按需切换。' : panel === 'runninghub' ? '独立云端工作流库，不改其它视频连接。' : '支持多份工作流，互不覆盖，不改生图设置。'}</span></div>
    {panel === 'runninghub' ? <RunningHubVideoSettings config={settings.runningHubVideo || defaultRunningHubVideoConfig} getCurrentConfig={() => currentSettings().runningHubVideo || defaultRunningHubVideoConfig} onChange={(next) => update(() => ({ runningHubVideo: next }))} /> : panel === 'api' ? <div className="vgs-main video-api-settings-form">
      <section className="vgs-card"><div className="vgs-card-title"><h3>视频连接库</h3><span>{profiles.length} 个已保存连接</span></div><div className="vgs-profile-row">
        <label className="field"><span>已保存的视频接口</span><select aria-label="已保存的视频接口" value={settings.activeVideoApiProfileId || ''} onChange={(event) => selectProfile(event.target.value)}><option value="">当前视频接口配置</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
        <label className="field"><span>连接名称</span><input aria-label="视频连接名称" value={profileName} placeholder="给这组连接起个名字" onChange={(event) => setProfileName(event.target.value)} /></label>
        <div className="vgs-actions"><button type="button" className="btn small" onClick={() => saveProfile(false)}><Save size={13} />保存连接</button><button type="button" className="btn small" onClick={() => saveProfile(true)}><Copy size={13} />另存为新接口</button><button type="button" className="btn small ghost" disabled={!selectedProfile} onClick={deleteProfile}><Trash2 size={13} />删除</button></div>
      </div></section>
      <section className="vgs-card"><div className="vgs-card-title"><h3>连接与认证</h3><label className="check-row video-settings-enable-row"><input type="checkbox" checked={api.enabled} onChange={(event) => patchApi({ enabled: event.target.checked })} />启用视频 API</label></div>
        <div className="vgs-fields vgs-fields-three"><label className="field"><span>接口协议</span><select aria-label="视频接口协议" value={api.provider || 'generic'} onChange={(event) => { const provider = event.target.value as VideoTaskApiConfig['provider']; if (provider === 'runninghub') applyRunningHubPreset(); else if (provider === 'rhtv_web') addRhTvProfile(); else patchApi(api.provider === 'rhtv_web' ? { provider, endpoint: '', statusEndpointTemplate: '', imageUploadEndpoint: '', cancelEndpointTemplate: '' } : { provider }); }}><option value="generic">通用视频 API</option><option value="minimax">MiniMax 官方视频 API</option><option value="runninghub">RunningHub AI 应用</option><option value="rhtv_web">rhTV 网页桥接（本机）</option></select></label>{api.provider !== 'rhtv_web' && <>{apiField('model', api.provider === 'runninghub' ? '显示名称（可选）' : '视频模型 ID', '填写接口支持的模型 ID')}{apiField('apiKey', 'API 密钥', '密钥仅保存在连接中', true)}
        {api.provider === 'runninghub' ? <>{apiField('runningHubAppId', 'RunningHub AI 应用 ID', '复制应用 API 示例中的应用 ID')}<label className="field"><span>实际提交端点</span><input aria-label="实际提交端点" readOnly value={videoApiSubmitEndpoint(api) || '请先填写应用 ID'} /></label></> : apiField('endpoint', '提交端点', 'https://…/videos')}{apiField('statusEndpointTemplate', '任务查询端点', 'https://…/videos/{id}')}</>}</div>
        {api.provider === 'rhtv_web' ? <RhTvBridgeSettings config={api} onChange={patchApi} /> : <div className="vgs-connection-footer">{permission}<button type="button" className="btn small" onClick={openAdvanced}><Settings2 size={14} />高级协议与请求模板</button></div>}
        {api.provider === 'minimax' && <div className="vgs-provider-note"><span>官方接口使用首尾帧，请核对模型与连接。</span><button type="button" className="btn small ghost" onClick={() => patchApi({ endpoint: 'https://api.minimaxi.com/v1/video_generation', statusEndpointTemplate: 'https://api.minimaxi.com/v1/query/video_generation?task_id={id}', taskIdPath: 'task_id', statusPath: 'status', fileIdPath: 'file_id', fileEndpointTemplate: 'https://api.minimaxi.com/v1/files/retrieve?file_id={id}', fileUrlPath: 'file.download_url', authHeader: 'Authorization', authScheme: 'Bearer' })}>填入 MiniMax 国内官方端点</button></div>}
        {api.provider === 'runninghub' && <div className="vgs-provider-note"><span>应用 ID、节点映射以该应用 API 示例为准，在高级设置填写 nodeInfoList。</span><button type="button" className="btn small ghost" onClick={applyRunningHubPreset}>恢复 RunningHub 预设</button></div>}
      </section>
    </div> : <div className="vgs-main comfyui-video-settings-form">
      <section className="vgs-card"><div className="vgs-card-title"><h3>ComfyUI 连接</h3><label className="check-row video-settings-enable-row"><input type="checkbox" checked={comfy.enabled} onChange={(event) => patchComfy({ enabled: event.target.checked })} />启用 ComfyUI 视频</label></div>
        <div className="vgs-fields"><label className="field"><span>ComfyUI 视频地址</span><input aria-label="ComfyUI 视频地址" value={comfy.baseUrl} placeholder="http://127.0.0.1:8188" onChange={(event) => patchComfy({ baseUrl: event.target.value })} /></label><label className="field"><span>认证密钥（本地通常留空）</span><input aria-label="ComfyUI 视频认证密钥" type="password" value={comfy.apiKey} onChange={(event) => patchComfy({ apiKey: event.target.value })} /></label>
        <label className="field"><span>接口路径模式</span><select aria-label="视频 ComfyUI 接口路径模式" value={pathMode} onChange={(event) => { const mode = event.target.value as 'standard' | 'custom'; setPathMode(mode); if (mode === 'standard') patchComfy({ promptPath: '/prompt' }); }}><option value="standard">标准 ComfyUI（/prompt）</option><option value="custom">自定义提交路径</option></select></label><label className="field"><span>任务提交路径</span><input aria-label="视频任务提交路径" disabled={pathMode === 'standard'} value={comfy.promptPath || '/prompt'} onChange={(event) => patchComfy({ promptPath: event.target.value })} /></label></div>
        <div className="vgs-connection-footer">{permission}<button type="button" className="btn small ghost" disabled={settings.imageApi.backend !== 'comfyui'} onClick={() => { const source = currentSettings().imageApi; patchComfy({ baseUrl: source.baseUrl, apiKey: source.apiKey }); setMessage('已复制生图连接地址与密钥；生图工作流未改动。'); }}><Copy size={13} />复制生图连接地址</button></div>
      </section>
      <section className="vgs-card vgs-workflow-card"><div className="vgs-card-title"><h3>视频工作流库</h3><span>{comfy.workflows.length} 份已保存</span></div><div className="vgs-workflow-row">
        <label className="field"><span>当前 Workflow</span><select aria-label="当前视频 Workflow" value={active?.id || ''} onChange={(event) => { const workflow = currentSettings().comfyuiVideo?.workflows.find((item) => item.id === event.target.value); if (workflow && isVideoWorkflowReady(workflow)) patchComfy({ activeWorkflowId: workflow.id }); }}><option value="" disabled>请选择已配置的视频工作流</option>{comfy.workflows.map((workflow) => <option key={workflow.id} value={workflow.id} disabled={!workflowReadiness.get(workflow.id)}>{workflow.name}{workflowReadiness.get(workflow.id) ? '' : ' · 待配置'}</option>)}</select></label>
        <div className="vgs-actions"><button type="button" className="btn small" disabled={importing} onClick={() => inputRef.current?.click()}><Upload size={14} />{importing ? '正在导入…' : '导入视频 API JSON'}</button><button type="button" className="btn small primary" onClick={() => setManagerOpen(true)}><FolderOpen size={14} />管理 Workflow</button></div></div>
        <input ref={inputRef} type="file" accept=".json,application/json" hidden onChange={(event) => { void importWorkflow(event); }} />
        <div className="vgs-workflow-summary" title={active?.id}><strong>当前实际生效：</strong><span>{active?.name || '尚未选择可用工作流'}</span>{active && <span className="vgs-summary-tags">提示词 {active.mapping.prompt.length} 处 · 图片 {active.mapping.images.length} 槽 · 输出 {active.mapping.outputNodeId || '自动识别'}</span>}</div>
        <p className="vgs-workflow-help">导入会新增，不覆盖已有工作流。复制、重命名、参数、节点映射和 JSON 在管理面板中编辑。</p>
      </section>
    </div>}
    <div className="vgs-feedback" aria-live="polite">{error ? <p className="vd-error" role="alert">{error}</p> : message ? <p className="vd-success" role="status">{message}</p> : <span>设置会自动保存。这里只配置连接，不会提交生成任务。</span>}</div>
    {managerOpen && <VideoWorkflowManager config={comfy} getCurrentConfig={() => currentSettings().comfyuiVideo || defaultComfyVideoConfig} onChange={(next) => update(() => ({ comfyuiVideo: next }))} initialWorkflowId={active?.id} onClose={() => setManagerOpen(false)} />}
    {advancedOpen && <div className="vgs-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeAdvanced(); }}><section ref={advancedDialogRef} className="vgs-api-dialog" role="dialog" aria-modal="true" aria-label="视频 API 高级设置">
      <header><div><h2>视频 API 高级设置</h2><p>当前连接：{selectedProfile?.name || api.model || '通用视频接口'}。只修改配置，不发送生成请求。</p></div><button type="button" className="btn small" onClick={closeAdvanced}><X size={14} />关闭</button></header>
      <div className="vgs-dialog-tabs" role="tablist" aria-label="视频 API 高级设置分类">{([['request', '请求模板'], ['response', '认证与结果映射'], ['media', '图片上传与取消']] as const).map(([value, label]) => <button type="button" className={`btn small ${advancedTab === value ? 'primary' : ''}`} role="tab" aria-selected={advancedTab === value} key={value} onClick={() => setAdvancedTab(value)}>{label}</button>)}</div>
      <div className="vgs-dialog-content">
        {advancedTab === 'request' && <div className="vgs-request-editor"><label className="field"><span>请求模板 JSON（留空使用协议默认请求）</span><textarea aria-label="视频请求模板 JSON" spellCheck={false} value={templateText} onChange={(event) => setTemplateText(event.target.value)} placeholder={'{ "prompt": "{{prompt}}", "images": "{{images}}", "parameters": "{{parameters}}" }'} /></label><p>可用：{'{{prompt}}、{{model}}、{{images}}、{{references}}、{{first_image}}、{{last_image}}、{{image_1}}、{{image_2}}、{{parameters}}'}。数组与对象保持原类型，密钥不要写入模板。</p>{api.provider === 'runninghub' && <p>RunningHub 的 nodeInfoList 按应用示例填真实节点 ID，fieldValue 可用 {'{{prompt}}'} 或 {'{{image_1}}'}。</p>}</div>}
        {advancedTab === 'response' && <div className="vgs-fields vgs-fields-three">{apiField('authHeader', '认证头名称', 'Authorization')}{apiField('authScheme', '认证前缀', 'Bearer')}{apiField('taskIdPath', '任务 ID 字段路径', 'id')}{apiField('statusPath', '任务状态字段路径', 'status')}{apiField('resultUrlPath', '视频下载 URL 字段路径', 'result.url')}{apiField('progressPath', '进度字段路径', 'progress')}{apiField('errorPath', '服务端错误字段路径', 'error.message')}{apiField('fileIdPath', '文件 ID 字段路径', 'file_id')}{apiField('fileEndpointTemplate', '根据文件 ID 取下载 URL', 'https://…/files/{id}')}{apiField('fileUrlPath', '文件下载 URL 字段路径', 'file.download_url')}</div>}
        {advancedTab === 'media' && <div className="vgs-media-editor"><div className="vgs-fields">{apiField('imageUploadEndpoint', '参考图片上传端点（可选）', '不填使用图片 data URL')}{apiField('imageUploadField', '上传表单字段', 'file')}{apiField('imageUploadUrlPath', '上传响应图片 URL 字段', 'url')}{apiField('cancelEndpointTemplate', '取消本任务端点（可选）', 'https://…/videos/{id}/cancel')}<label className="field"><span>取消请求方法</span><select aria-label="取消请求方法" value={api.cancelMethod || 'POST'} onChange={(event) => patchApi({ cancelMethod: event.target.value as 'POST' | 'DELETE' })}><option value="POST">POST</option><option value="DELETE">DELETE</option></select></label></div><p>没有取消接口时只停止本地追踪，不保证服务器停止或退款；不会重新提交原任务。</p></div>}
      </div>
      <footer><div>{templateError ? <p className="vd-error" role="alert">{templateError}</p> : <span>{templateText !== templateBaseline ? '请求模板有未保存修改' : '字段修改自动保存；请求模板需点保存。'}</span>}</div><button type="button" className="btn primary" onClick={saveTemplate}><Save size={14} />保存请求模板</button></footer>
    </section></div>}
  </section>;
}
