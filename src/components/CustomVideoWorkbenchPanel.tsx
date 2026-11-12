import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Film, ImagePlus, Library, Send, Trash2, Upload, X } from 'lucide-react';
import type { AppSettings, Project, ReferenceAsset, ReferenceRole, VideoGenerationTask } from '../types';
import type { CustomVideoDraft, VideoGenerationController, VideoGenerationDraft, VideoGenerationSource, VideoImageReference } from '../videoGenerationTypes';
import { assetPreviewUrl } from '../media';
import { isVideoGenerationTask } from '../generationTasks';
import { videoConfiguredApiState, videoDraftSource, videoParameterConnectionKey, videoSourceDraftPatch } from '../videoGenerationSource';
import { availableVideoParameterKeys, changeVideoParameterText, readVideoParameterText, videoOutputParameterPresentation } from '../videoOutputParameters';
import { VideoOutputParameters } from './VideoOutputParameters';
import { videoAudioBindingId, isVideoDirectorAudio } from '../videoAudioReferences';
import { videoAudioCapability } from '../videoAudioCapabilities';
import { useVideoRuntimes } from '../videoRuntimeStore';
import { videoReferenceSlotIndex } from '../videoReferenceSlots';
import { getVideoApiImageCapacity } from '../videoImageCapacity';
import type { VideoApiParameterReaderProps } from './VideoApiParameterReader';
import { VideoMotionReferenceEditor } from './VideoMotionReferences';
import { AssetVideoThumbnail } from './AssetVideoThumbnail';
import { isRunningHubWebAppReady } from '../runningHubWeb';
import { isRunningHubH3AutoPromptInput } from '../runningHubPromptPictures';
import { videoDraftReferenceAsset } from '../videoDirectorReferences';
import '../customVideoWorkbench.css';

const imageRoles: Array<{ value: ReferenceRole; label: string }> = [
  { value: 'first-frame', label: '首帧' }, { value: 'last-frame', label: '尾帧' },
  { value: 'character', label: '人物参考' }, { value: 'private-part', label: '私密部位' }, { value: 'scene', label: '场景参考' },
  { value: 'prop', label: '道具参考' }, { value: 'style', label: '风格参考' },
  { value: 'motion', label: '动作参考' }, { value: 'composition', label: '构图参考' },
  { value: 'general', label: '通用参考' },
];

export const defaultCustomVideoDraft = (): CustomVideoDraft => ({
  version: 1,
  draft: { name: '', prompt: '', origin: 'custom', promptMode: 'raw', backend: 'api', references: [],
    referenceSlotRoles: [], audioReferences: [], audioSelectionMode: 'none', videoReferences: [], parameters: {} },
  parameterText: '{}', parameterDrafts: [],
});

export interface CustomVideoWorkbenchPanelProps {
  project: Project;
  settings: AppSettings;
  controller: VideoGenerationController;
  draft?: CustomVideoDraft;
  onDraftChange: (draft: CustomVideoDraft) => void;
  onImportImageFiles: (files: File[]) => Promise<ReferenceAsset[]>;
  onOpenSettings?: () => void;
  onOpenJobs?: () => void;
  onOpenVideoAssets?: () => void;
  onVideoApiParametersChange?: VideoApiParameterReaderProps['onChange'];
  onPlayVideo: (asset: ReferenceAsset) => void;
  phoneLayout?: boolean;
}

const statusLabel = (task: VideoGenerationTask, stage = task.videoJob?.stage): string => {
  if (task.status === 'succeeded') return '已完成';
  if (task.status === 'failed') return '生成失败';
  if (task.status === 'unknown') return '提交结果待确认';
  if (stage === 'stopped') return '已停止本地追踪';
  if (stage === 'preparing') return '准备素材';
  if (stage === 'submitting') return '正在提交';
  if (stage === 'queued') return '排队中';
  if (stage === 'downloading') return '生成成功，正在保存';
  if (stage === 'reconnecting') return '恢复状态中';
  return '生成中';
};

const taskResults = (task: VideoGenerationTask, assets: ReferenceAsset[]): ReferenceAsset[] => {
  const ids = [...new Set([...(task.videoJob?.resultAssetIds || []), ...(task.resultAssetId ? [task.resultAssetId] : [])])];
  return ids.map((id) => assets.find((asset) => asset.id === id)).filter((asset): asset is ReferenceAsset => Boolean(asset && (asset.mediaType === 'video' || asset.type === 'video')));
};

export function CustomVideoWorkbenchPanel({ project, settings, controller, draft: providedDraft, onDraftChange, onImportImageFiles,
  onOpenSettings, onPlayVideo, phoneLayout = false }: CustomVideoWorkbenchPanelProps) {
  const savedDraft = providedDraft || defaultCustomVideoDraft();
  const draft = savedDraft.draft;
  const parameterText = savedDraft.parameterText || JSON.stringify(draft.parameters || {}, null, 2);
  const source = videoDraftSource(draft);
  const apiState = useMemo(() => videoConfiguredApiState(settings, { ...draft, parameters: draft.parameters || {} }), [settings, draft]);
  const api = apiState.api;
  const workflow = settings.comfyuiVideo?.workflows.find((item) => item.id === draft.workflowId);
  const parameterPresentation = videoOutputParameterPresentation(api, draft.parameters);
  const parameterKeys = availableVideoParameterKeys(source, api, workflow);
  const imageAssets = project.assets.filter((asset) => !asset.missing && asset.mediaType !== 'video' && asset.mediaType !== 'audio'
    && asset.type !== 'video' && asset.type !== 'audio' && Boolean(assetPreviewUrl(asset)));
  const customTasks = project.generationTasks.filter(isVideoGenerationTask).filter((task) => !task.historyOnly && task.videoJob?.snapshot.draft.origin === 'custom')
    .sort((left, right) => left.createdAt - right.createdAt);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [assetQuery, setAssetQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState('');
  const [notice, setNotice] = useState('');
  const [uploadBusy, setUploadBusy] = useState(false);
  const [emptyH3Mode, setEmptyH3Mode] = useState<'reference' | 'keyframe'>(() => draft.references.some((reference) => reference.role === 'first-frame' || reference.role === 'last-frame') ? 'keyframe' : 'reference');
  const h3Mode = draft.references.some((reference) => reference.role === 'first-frame' || reference.role === 'last-frame') ? 'keyframe'
    : draft.references.length || draft.audioReferences?.length || draft.videoReferences?.length ? 'reference' : emptyH3Mode;
  const h3Keyframe = api?.provider === 'minimax_h3' && h3Mode === 'keyframe';
  const h3KeyframeFull = h3Keyframe && draft.references.length >= 2;
  const roleOptions = api?.provider === 'minimax_h3' ? imageRoles.filter((role) => h3Keyframe
    ? role.value === 'first-frame' || role.value === 'last-frame' : role.value !== 'first-frame' && role.value !== 'last-frame') : imageRoles;
  const fileInput = useRef<HTMLInputElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const latest = useRef({ projectId: project.id, savedDraft, onDraftChange, h3Keyframe });
  latest.current = { projectId: project.id, savedDraft, onDraftChange, h3Keyframe };
  const status = useVideoRuntimes(controller.runtimeStore, controller.runtimeById);
  const lastTask = customTasks[customTasks.length - 1];
  const lastTaskResultCount = lastTask?.videoJob?.resultAssetIds?.length || (lastTask?.resultAssetId ? 1 : 0);
  useEffect(() => {
    if (history.current) history.current.scrollTop = history.current.scrollHeight;
  }, [lastTask?.id, lastTask?.status, lastTaskResultCount]);
  const imageSlotCount = draft.backend === 'comfyui' ? workflow?.mapping.images.length
    : api?.provider === 'runninghub' ? api.runningHubImageRoles?.length
      : api?.provider === 'rh_web' ? api.rhWebFields?.filter((field) => field.bind === 'image').length
        : api?.provider === 'minimax_h3' ? h3Keyframe ? 2 : 9 : api?.provider === 'minimax' ? 2 : getVideoApiImageCapacity(api)?.maxCount;
  const audioCapability = videoAudioCapability(api, draft.backend);
  const audioCapacity = api?.provider === 'minimax_h3' ? 3 : api?.provider === 'rh_web'
    ? api.rhWebFields?.filter((field) => field.bind === 'audio').length || 0 : audioCapability.capacity;
  const audioAssets = project.assets.filter(isVideoDirectorAudio);
  const pickerClose = useRef(() => setPickerOpen(false));
  pickerClose.current = () => setPickerOpen(false);
  useEffect(() => {
    if (!pickerOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') pickerClose.current(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [pickerOpen]);
  useEffect(() => { setPickerOpen(false); setIssue(''); setNotice(''); }, [project.id]);

  const saveDraft = (nextDraft: VideoGenerationDraft, nextParameterText: string, drafts = new Map(savedDraft.parameterDrafts)) => {
    const nextApi = videoConfiguredApiState(settings, { ...nextDraft, parameters: {} }).api;
    drafts.set(JSON.stringify([videoParameterConnectionKey(nextDraft), nextApi?.provider || '', nextApi?.model || '']), nextParameterText);
    onDraftChange({ ...savedDraft, version: 1, draft: nextDraft, parameterText: nextParameterText, parameterDrafts: [...drafts],
      parameterConnectionKey: JSON.stringify([videoParameterConnectionKey(nextDraft), nextApi?.provider || '', nextApi?.model || '']) });
  };
  const parameterKey = (candidate: VideoGenerationDraft) => {
    const candidateApi = videoConfiguredApiState(settings, { ...candidate, parameters: {} }).api;
    return JSON.stringify([videoParameterConnectionKey(candidate), candidateApi?.provider || '', candidateApi?.model || '']);
  };
  const currentParameterKey = parameterKey(draft);
  useEffect(() => {
    if (!savedDraft.parameterConnectionKey || savedDraft.parameterConnectionKey === currentParameterKey) return;
    const drafts = new Map(savedDraft.parameterDrafts);
    drafts.set(savedDraft.parameterConnectionKey, parameterText);
    const text = drafts.get(currentParameterKey) || '{}';
    const parsed = readVideoParameterText(text);
    onDraftChange({ ...savedDraft, parameterConnectionKey: currentParameterKey, parameterText: text,
      parameterDrafts: [...drafts], draft: { ...draft, parameters: parsed.value } });
  }, [currentParameterKey, savedDraft.parameterConnectionKey]);

  const patch = (next: Partial<VideoGenerationDraft>, nextParameterText = parameterText) => {
    const nextDraft = { ...draft, ...next, origin: 'custom' as const, promptMode: 'raw' as const };
    saveDraft(nextDraft, nextParameterText);
  };

  const selectedSource = (nextSource: VideoGenerationSource) => {
    const connectionPatch = videoSourceDraftPatch(nextSource, settings);
    const nextDraft = { ...draft, ...connectionPatch, h3MediaMode: undefined, reuseTaskId: undefined };
    const drafts = new Map(savedDraft.parameterDrafts);
    drafts.set(parameterKey(draft), parameterText);
    const nextParameterText = drafts.get(parameterKey(nextDraft)) || '{}';
    const parsed = readVideoParameterText(nextParameterText);
    saveDraft({ ...nextDraft, parameters: parsed.issue ? {} : parsed.value }, nextParameterText, drafts);
  };

  const chooseConnection = (value: string) => {
    const connectionPatch = source === 'api' ? { apiProfileId: value || undefined, runningHubWorkflowId: undefined, runningHubWebAppId: undefined, workflowId: undefined }
      : source === 'comfyui' ? { workflowId: value || undefined, apiProfileId: undefined, runningHubWorkflowId: undefined, runningHubWebAppId: undefined }
        : source === 'runninghub' ? { runningHubWorkflowId: value || undefined, apiProfileId: undefined, runningHubWebAppId: undefined, workflowId: undefined }
          : { runningHubWebAppId: value || undefined, apiProfileId: undefined, runningHubWorkflowId: undefined, workflowId: undefined };
    const nextDraft = { ...draft, ...connectionPatch, reuseTaskId: undefined };
    const drafts = new Map(savedDraft.parameterDrafts);
    drafts.set(parameterKey(draft), parameterText);
    const nextParameterText = drafts.get(parameterKey(nextDraft)) || '{}';
    const parsed = readVideoParameterText(nextParameterText);
    saveDraft({ ...nextDraft, parameters: parsed.issue ? {} : parsed.value }, nextParameterText, drafts);
  };

  const updateParameter = (key: string, value: string) => {
    const changed = changeVideoParameterText(parameterText, key, value);
    patch({ parameters: changed.value }, changed.text);
  };

  const updateParameterJson = (value: string) => {
    const parsed = readVideoParameterText(value);
    patch({ parameters: parsed.issue ? draft.parameters : parsed.value }, value);
  };

  const patchReferences = (references: VideoImageReference[]) => {
    if (api?.provider === 'minimax_h3' && !h3Keyframe) references = references
      .map((reference, index) => ({ reference, index }))
      .sort((a, b) => videoReferenceSlotIndex(a.reference, a.index) - videoReferenceSlotIndex(b.reference, b.index))
      .map(({ reference }, slotIndex) => ({ ...reference, slotIndex }));
    const referenceSlotRoles: ReferenceRole[] = [];
    for (let index = 0; index < references.length; index += 1) referenceSlotRoles[videoReferenceSlotIndex(references[index], index)] = references[index].role;
    patch({ references, referenceSlotRoles, h3MediaMode: undefined, reuseTaskId: undefined });
  };

  const addAssets = (assets: ReferenceAsset[]) => {
    if (!assets.length) return;
    const current = latest.current.savedDraft;
    const byId = new Map(current.draft.references.map((reference) => [reference.assetId, reference]));
    for (const asset of assets) if (!byId.has(asset.id)) {
      const occupied = new Set([...byId.values()].map((reference, index) => videoReferenceSlotIndex(reference, index)));
      let slotIndex = 0;
      while (occupied.has(slotIndex)) slotIndex += 1;
      const role: ReferenceRole = latest.current.h3Keyframe ? slotIndex === 0 ? 'first-frame' : 'last-frame'
        : api?.provider === 'minimax_h3' ? asset.referenceRole && !['first-frame', 'last-frame'].includes(asset.referenceRole) ? asset.referenceRole : 'general'
          : asset.type === 'first-frame' ? 'first-frame' : asset.type === 'last-frame' ? 'last-frame' : asset.referenceRole || 'general';
      byId.set(asset.id, { assetId: asset.id, slotIndex, role });
    }
    const references = [...byId.values()];
    const referenceSlotRoles: ReferenceRole[] = [];
    for (let index = 0; index < references.length; index += 1) referenceSlotRoles[videoReferenceSlotIndex(references[index], index)] = references[index].role;
    latest.current.onDraftChange({ ...current, draft: { ...current.draft, references, referenceSlotRoles, h3MediaMode: undefined, reuseTaskId: undefined } });
  };

  const importImages = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    const requestedProjectId = project.id;
    setUploadBusy(true); setIssue('');
    try {
      const assets = await onImportImageFiles(files);
      if (latest.current.projectId === requestedProjectId) addAssets(assets);
    }
    catch (cause) { setIssue(cause instanceof Error ? cause.message : String(cause)); }
    finally { setUploadBusy(false); }
  };

  const submit = async () => {
    if (busy || !draft.prompt.trim()) return;
    const parameters = readVideoParameterText(parameterText);
    if (parameters.issue) { setIssue(parameters.issue); return; }
    setBusy(true); setIssue(''); setNotice('');
    try {
      await controller.start({ ...draft, origin: 'custom', promptMode: 'raw', source: undefined,
        parameters: parameters.value,
        audioSelectionMode: draft.audioReferences?.length ? 'override' : 'none', reuseTaskId: undefined });
      setNotice('已提交自定义视频任务。');
    } catch (cause) { setIssue(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const visibleImages = imageAssets.filter((asset) => `${asset.name} ${asset.fileName || ''} ${asset.tags.join(' ')}`
    .toLocaleLowerCase('zh-CN').includes(assetQuery.trim().toLocaleLowerCase('zh-CN')));
  const selectItems = (label: string, value: string, options: Array<{ id: string; label: string; disabled?: boolean }>) =>
    <label className="field"><span>{label}</span><select value={value} onChange={(event) => chooseConnection(event.target.value)}>
      {!options.some((option) => option.id === '') && <option value="">请选择</option>}{options.map((option) => <option key={option.id} value={option.id} disabled={option.disabled}>{option.label}</option>)}
    </select></label>;

  return <section className={`custom-video-panel${phoneLayout ? ' custom-video-panel-phone' : ''}`} aria-label="自定义生成视频">
    <div className="custom-video-history" ref={history} role="log" aria-label="自定义视频生成历史" aria-live="polite" aria-relevant="additions">
      {!customTasks.length && <div className="custom-video-empty"><Film size={30} /><strong>自定义生成视频</strong></div>}
      {customTasks.map((task) => {
        const resultAssets = taskResults(task, project.assets);
        const taskDraft = task.videoJob?.snapshot.draft;
        const snapshot = task.videoJob?.snapshot;
        const references = taskDraft?.references || [];
        const referenceAssets = references.map((reference) => videoDraftReferenceAsset(project, reference, snapshot));
        const runtime = status[task.id];
        const stage = runtime?.stage || task.videoJob?.stage;
        const active = !['succeeded', 'failed', 'stopped', 'submission-unknown'].includes(stage || task.status);
        const prompt = taskDraft?.prompt || task.requestBody.prompt?.toString() || '';
        const model = task.videoJob?.snapshot.connection.api?.model || task.videoJob?.snapshot.connection.workflow?.name || task.targetId;
        return <article className="custom-video-turn" key={task.id} data-task-id={task.id}>
          <div className="custom-video-user">
            <div className="custom-video-user-text">{prompt}</div>
            {referenceAssets.some(Boolean) && <div className="custom-video-message-references">{referenceAssets.map((asset, index) => <span key={`${task.id}-${index}`}>
              {asset && assetPreviewUrl(asset) && <img src={assetPreviewUrl(asset)} alt="" loading="lazy" />}
              {references[index]?.role === 'first-frame' ? '首帧' : references[index]?.role === 'last-frame' ? '尾帧' : `参考图 ${index + 1}`}
            </span>)}</div>}
            <div className="custom-video-meta">{taskDraft?.name || '自定义视频'} · {model} · {new Date(task.createdAt).toLocaleString('zh-CN')}</div>
          </div>
          <div className="custom-video-result-turn">
            <div className={`custom-video-status ${task.status === 'failed' ? 'is-failed' : task.status === 'succeeded' ? 'is-done' : ''}`}>
              {statusLabel(task, stage)}
              {(runtime?.message || task.videoJob?.message) && <span className="custom-video-meta">{runtime?.message || task.videoJob?.message}</span>}
            </div>
            {resultAssets.length > 0 && <div className="custom-video-results" aria-label="本任务生成的视频">
              {resultAssets.map((asset) => <div className="custom-video-result" key={asset.id}><AssetVideoThumbnail projectId={project.id} asset={asset} assets={project.assets} onPlay={() => onPlayVideo(asset)} /><span>{asset.name}</span></div>)}
            </div>}
            {task.error && <p className="custom-video-error" role="alert">{task.error}</p>}
            <div className="custom-video-task-actions">
              {active && <button type="button" className="btn small ghost" onClick={() => void controller.cancel(task.id).catch((cause) => setIssue(cause instanceof Error ? cause.message : String(cause)))}>停止追踪</button>}
              {!active && task.videoJob?.trackingStopped && task.remoteTaskId && <button type="button" className="btn small ghost" onClick={() => void controller.resume(task.id).catch((cause) => setIssue(cause instanceof Error ? cause.message : String(cause)))}>恢复查询</button>}
              {task.videoJob?.downloadError && <button type="button" className="btn small ghost" onClick={() => void controller.retryDownload(task.id).catch((cause) => setIssue(cause instanceof Error ? cause.message : String(cause)))}>重新获取成片</button>}
            </div>
          </div>
        </article>;
      })}
    </div>

    <div className="custom-video-composer">
      {draft.references.length > 0 && <div className="custom-video-attachments" aria-label="本次参考图片">
        {draft.references.map((reference, index) => {
          const asset = project.assets.find((item) => item.id === reference.assetId);
          return <div className="custom-video-attachment" key={`${reference.assetId}-${index}`}>
            {asset && assetPreviewUrl(asset) && <img src={assetPreviewUrl(asset)} alt="" />}
            <span>{reference.role === 'first-frame' ? '首帧' : reference.role === 'last-frame' ? '尾帧' : asset?.name || `参考图 ${index + 1}`}</span>
            <button type="button" aria-label={`移除参考图 ${index + 1}`} onClick={() => patchReferences(draft.references.filter((_, offset) => offset !== index))}><X size={13} /></button>
          </div>;
        })}
      </div>}
      <textarea aria-label="自定义视频提示词" className="custom-video-prompt" value={draft.prompt} onChange={(event) => patch({ prompt: event.target.value, source: undefined, h3ReferenceBinding: undefined, seedanceReferenceBinding: undefined, audioReferenceBinding: undefined, videoReferenceBinding: undefined, reuseTaskId: undefined })} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void submit(); } }} placeholder="输入希望生成的视频内容。默认原文发送。" />
      <div className="custom-video-action-bar">
        <button type="button" className="btn small" aria-label="上传图片" disabled={uploadBusy || h3KeyframeFull} onClick={() => fileInput.current?.click()} title="上传参考图片"><Upload size={14} /></button>
        <button type="button" className="btn small" aria-label="选图片" disabled={h3KeyframeFull} onClick={() => setPickerOpen(true)} title="从资产库选择图片"><Library size={14} /></button>
        <input ref={fileInput} hidden type="file" accept="image/*" multiple={!h3Keyframe} aria-label="上传自定义视频参考图片" onChange={(event) => void importImages(event)} />
        <div className="custom-video-source-controls">
          <label className="field"><span>渠道</span><select value={source} onChange={(event) => selectedSource(event.target.value as VideoGenerationSource)}>
            <option value="api">视频 API</option><option value="runninghub">RunningHub 云端</option><option value="runninghub-web">RH 网页应用</option><option value="comfyui">ComfyUI 工作流</option>
          </select></label>
          {source === 'api' && selectItems('视频 API 配置', draft.apiProfileId || '', [
            { id: '', label: `当前连接 · ${settings.videoTaskApi.model || '未命名模型'}` },
            ...(settings.videoApiProfiles || []).map((item) => ({ id: item.id, label: `${item.name} · ${item.model || '未命名模型'}` })),
          ])}
          {source === 'runninghub' && selectItems('RunningHub 工作流', draft.runningHubWorkflowId || '', (settings.runningHubVideo?.workflows || []).map((item) => ({ id: item.id, label: item.name })))}
          {source === 'runninghub-web' && selectItems('RH 网页应用', draft.runningHubWebAppId || '', (settings.runningHubWeb?.apps || []).map((item) => ({ id: item.id, label: `${item.name} · ${item.site === 'cn' ? '国内站' : '国际站'}`, disabled: !isRunningHubWebAppReady(item) })))}
          {source === 'comfyui' && selectItems('ComfyUI 工作流', draft.workflowId || '', (settings.comfyuiVideo?.workflows || []).map((item) => ({ id: item.id, label: `${item.name} · ${item.mapping.images.length} 个图槽` })))}
        </div>
        <button type="button" className="btn primary custom-video-submit" disabled={busy || uploadBusy || !draft.prompt.trim()} onClick={() => void submit()}><Send size={15} />{busy ? '提交中' : '生成视频'}</button>
      </div>
      {apiState.issue && <p className="custom-video-error" role="status">{apiState.issue}</p>}
      {notice && <p className="custom-video-notice" role="status">{notice}</p>}{issue && <p className="custom-video-error" role="alert">{issue}</p>}

      <details className="custom-video-settings">
        <summary>图片用途、视频名称与高级设置</summary>
        <div className="custom-video-settings-body">
          <div className="custom-video-settings-heading"><span>本次图片 {draft.references.length} 张{imageSlotCount !== undefined ? ` / ${imageSlotCount} 个输入槽` : ''}</span></div>
          {api?.provider === 'minimax_h3' && <label className="field custom-video-h3-mode"><span>H3 输入模式</span><select aria-label="自定义 H3 输入模式" value={h3Mode} onChange={(event) => {
        const mode = event.target.value as 'reference' | 'keyframe';
        setEmptyH3Mode(mode);
        patchReferences(draft.references.map((reference, index) => ({ ...reference, slotIndex: index,
          role: mode === 'keyframe' ? index === 0 ? 'first-frame' : 'last-frame' : reference.role === 'first-frame' || reference.role === 'last-frame' ? 'general' : reference.role })));
      }}><option value="reference">多素材参考 / 文生视频</option><option value="keyframe" disabled={draft.references.length > 2 || Boolean(draft.audioReferences?.length || draft.videoReferences?.length)}>首尾帧 / 文生视频</option></select>
        <small>首尾帧模式使用最多两张边界图；多素材参考模式可选择人物图、音频和视频。移除参考音视频后可切换首尾帧。</small>
      </label>}
      {api?.provider === 'runninghub' && isRunningHubH3AutoPromptInput(api) && <p className="custom-video-note">此云端应用内含提示词生成器，远端仍可能转换正文；本软件按原文传给已绑定输入。</p>}
      {api?.provider === 'rh_web' && api.rhWebFields?.some((field) => field.bind === 'idea') && <p className="custom-video-note">已识别的“自动提示词”将在本次请求中关闭；其他工作流内部处理仍由应用决定。</p>}

      <div className="custom-video-image-strip">
        {source === 'comfyui' && <p className="custom-video-note">本次选择只替换对应图片槽；未选择的槽沿用工作流原值。</p>}
        <div className="custom-video-image-list">
          {draft.references.map((reference, index) => {
            const asset = project.assets.find((item) => item.id === reference.assetId);
            return <div className="custom-video-image-item" key={`${reference.assetId}:${index}`}>
              {asset && assetPreviewUrl(asset) ? <img src={assetPreviewUrl(asset)} alt={asset.name} loading="lazy" /> : <span className="custom-video-image-missing">图片不可用</span>}
              <span className="custom-video-image-name" title={asset?.name || reference.assetId}>{asset?.name || '图片已移除'}</span>
              <label className="field"><span>输入槽</span><select aria-label={`图片 ${index + 1} 输入槽`} value={videoReferenceSlotIndex(reference, index)} onChange={(event) => {
                const slotIndex = Number(event.target.value);
                const previousSlot = videoReferenceSlotIndex(reference, index);
                patchReferences(draft.references.map((item, position) => position === index ? { ...item, slotIndex, ...(h3Keyframe ? { role: slotIndex === 0 ? 'first-frame' as const : 'last-frame' as const } : {}) }
                  : videoReferenceSlotIndex(item, position) === slotIndex ? { ...item, slotIndex: previousSlot, ...(h3Keyframe ? { role: previousSlot === 0 ? 'first-frame' as const : 'last-frame' as const } : {}) } : item));
              }}>{Array.from({ length: api?.provider === 'minimax_h3' && !h3Keyframe ? draft.references.length : Math.max(imageSlotCount || draft.references.length, videoReferenceSlotIndex(reference, index) + 1) }, (_, slotIndex) =>
                <option key={slotIndex} value={slotIndex}>图片槽 {slotIndex + 1}</option>)}</select></label>
              <label className="field"><span>图片用途</span><select aria-label={`图片槽 ${videoReferenceSlotIndex(reference, index) + 1} 用途`} value={reference.role} disabled={h3Keyframe} onChange={(event) => {
                const role = event.target.value as ReferenceRole;
                patchReferences(draft.references.map((item, position) => position === index ? { ...item, role } : item));
              }}>{!roleOptions.some((role) => role.value === reference.role) && <option value={reference.role}>{reference.role}</option>}{roleOptions.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label>
              <button type="button" className="custom-video-remove" aria-label={`移除图片槽 ${videoReferenceSlotIndex(reference, index) + 1}`} title="移除图片" onClick={() => {
                patchReferences(draft.references.filter((_, position) => position !== index));
              }}><Trash2 size={14} /></button>
            </div>;
          })}
        </div>
      </div>

      <label className="field custom-video-name"><span>视频名称（可选）</span><input value={draft.name} onChange={(event) => patch({ name: event.target.value })} placeholder="用于任务和资产名称" /></label>

      {!h3Keyframe && <VideoMotionReferenceEditor project={project} draft={{ ...draft, origin: 'custom', promptMode: 'raw' }} api={api} workflow={workflow} scope="自定义生成" onChange={(value) => patch(value)} />}
      {!h3Keyframe && (audioCapacity > 0 || Boolean(draft.audioReferences?.length)) && <details className="custom-video-audio"><summary>参考音频 · 本次 {draft.audioReferences?.length || 0} 条</summary>
        <p className="custom-video-note">只使用此处明确选择的音频；不继承项目声音预设。音色及原音的使用效果由模型或工作流决定。</p>
        <div className="custom-video-audio-grid">{Array.from({ length: Math.max(audioCapacity, ...(draft.audioReferences || []).map((reference) => reference.slotIndex + 1), 0) }, (_, slotIndex) => {
          const reference = draft.audioReferences?.find((item) => item.slotIndex === slotIndex);
          const bindingId = api?.provider === 'minimax_h3' ? `minimax-h3-audio-${slotIndex + 1}`
            : api?.provider === 'rh_web' ? `rh-web-audio-${slotIndex + 1}` : videoAudioBindingId(api, slotIndex);
          const asset = reference && audioAssets.find((item) => item.id === reference.assetId);
          return <label key={slotIndex} className="field"><span>音频槽 {slotIndex + 1}</span><select aria-label={`自定义参考音频 ${slotIndex + 1}`} value={reference?.assetId || ''} onChange={(event) => {
            const references = (draft.audioReferences || []).filter((item) => item.slotIndex !== slotIndex);
            if (event.target.value) references.push({ assetId: event.target.value, slotIndex, bindingId, target: { kind: 'voiceover' }, retainMode: 'reference' });
            patch({ audioReferences: references.sort((left, right) => left.slotIndex - right.slotIndex), audioSelectionMode: references.length ? 'override' : 'none', reuseTaskId: undefined });
          }}><option value="">不使用参考音频</option>{reference && !asset && <option value={reference.assetId}>原音频已不存在</option>}{audioAssets.map((item) => <option key={item.id} value={item.id} disabled={Boolean(item.missing)}>{item.name}</option>)}</select>
            {asset && assetPreviewUrl(asset) && <audio controls preload="none" src={assetPreviewUrl(asset)} aria-label={`参考音频 ${slotIndex + 1} 试听`} />}
          </label>;
        })}</div>
      </details>}

      <details className="custom-video-parameters"><summary>生成参数</summary>
        <VideoOutputParameters scope="single" source={source} parameterText={parameterText} availableKeys={parameterKeys}
          controls={parameterPresentation.controls} defaultValues={parameterPresentation.defaultValues}
          upstreamParameters={parameterPresentation.upstreamParameters} requiresMapping={source !== 'api'}
          pageParameters={source === 'runninghub-web' ? (api?.rhWebFields || []).filter((field) => ['duration', 'aspect_ratio', 'megapixels'].includes(field.bind)).map((field) => ({ label: field.label, value: String(field.value) })) : []}
          onChange={updateParameter} onOpenSettings={onOpenSettings} />
        <label className="field"><span>其他参数 JSON</span><textarea aria-label="自定义视频其他参数 JSON" className="custom-video-json" rows={4} value={parameterText} onChange={(event) => updateParameterJson(event.target.value)} /><small>仅用于当前连接参数。提示词、模型和图片以本页输入为准。</small></label>
      </details>
        </div>
      </details>
    </div>

    {pickerOpen && <div className="custom-video-picker-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPickerOpen(false); }}>
      <section className="custom-video-picker" role="dialog" aria-modal="true" aria-label="选择视频图片">
        <header><div><h3>选择图片资产</h3><p>可多选，按选择顺序设置图片槽用途。</p></div><button type="button" className="btn small" onClick={() => setPickerOpen(false)}>关闭</button></header>
        <label className="field"><span>搜索图片</span><input type="search" value={assetQuery} onChange={(event) => setAssetQuery(event.target.value)} placeholder="名称、文件名或标签" /></label>
        <div className="custom-video-picker-grid">{visibleImages.map((asset) => {
          const selectedIndex = draft.references.findIndex((reference) => reference.assetId === asset.id);
          const selected = selectedIndex >= 0;
          return <button type="button" key={asset.id} className={`custom-video-picker-item${selected ? ' is-selected' : ''}`} aria-pressed={selected} disabled={!selected && h3KeyframeFull} onClick={() => {
            if (selected) {
              patchReferences(draft.references.filter((reference) => reference.assetId !== asset.id));
            } else addAssets([asset]);
          }}>
            <img src={assetPreviewUrl(asset)} alt={asset.name} loading="lazy" /><strong>{asset.name}</strong><small>{selected ? `已选 · 图片槽 ${selectedIndex + 1}` : `${asset.width || '?'} × ${asset.height || '?'}`}</small>
          </button>;
        })}{!visibleImages.length && <p className="custom-video-no-images"><ImagePlus size={20} />没有可选图片</p>}</div>
        <footer><span>已选 {draft.references.length} 张</span><button type="button" className="btn primary" onClick={() => setPickerOpen(false)}>完成</button></footer>
      </section>
    </div>}
  </section>;
}
