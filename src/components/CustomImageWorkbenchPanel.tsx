import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { BookOpen, Copy, ImagePlus, Library, MessageSquare, RefreshCw, ScanSearch, Send, Square, Trash2, Upload, X } from 'lucide-react';
import type { AppState, CustomImageDraft, ImageGenerationTask, ImagePromptReverseTask, ReferenceAsset } from '../types';
import { applyOwnedProjectUpdate, buildLocalReferenceAsset } from '../appEffects';
import { createId, readImageAsDataUrl } from '../storage';
import { assetPreviewUrl } from '../media';
import { referenceImageMimeType } from '../imageReferenceData';
import { defaultImageOutputSize, resolveImageOutputSize } from '../imageOutputSize';
import { resolveWorkbenchImageApi, imageApiChoiceLabel } from '../imageApiSelection';
import { imageReferenceSnapshotAssets } from '../imageGeneration';
import { cancelQueuedGenerationTask, forceStopImageGenerationTask, forceStopImageTask, imageGenerationStatusLabel, revokeQueuedGenerationTask } from '../generationTasks';
import { captureCustomImageRule } from '../customImagePrompt';
import { submitCustomImage, retryCustomImageTask, retryCustomImageSave, type CustomImageGenerationContext } from '../customImageGeneration';
import { getSafeErrorDiagnostics } from '../errorDiagnostics';
import { ReferenceImagePickerModal } from './ReferenceImagePickerModal';
import { ImageOutputSizeControls } from './ImageOutputSizeControls';
import { AssetImagePreview } from './AssetImagePreview';
import { submitImagePromptReverse, stopImagePromptReverse, retryImagePromptReverse, imagePromptReverseStatusLabel } from '../imagePromptReverse';
import { ImagePromptReverseResultView, ImagePromptReverseReferencePreview, formatImagePromptReverseResult } from './ImagePromptReverseResult';
import { validateRunningHubImageConfig } from '../runningHubImage';
import '../customImageWorkbench.css';

export const defaultCustomImageDraft = (): CustomImageDraft => ({
  version: 1, userPrompt: '', referenceAssetIds: [],
  sizePreference: { ...defaultImageOutputSize(), aspect: '1:1' }, promptMode: 'raw',
});

interface Props {
  state: AppState;
  context: CustomImageGenerationContext;
  onOpenAssets: () => void;
  onManageRules: () => void;
  focusReverseTaskId?: string;
  onReverseFocusHandled?: () => void;
}

export function CustomImageWorkbenchPanel({ state, context, onOpenAssets, onManageRules, focusReverseTaskId, onReverseFocusHandled }: Props) {
  const projectId = state.project.id;
  const draft = state.project.customImageDraft || defaultCustomImageDraft();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reversePickerOpen, setReversePickerOpen] = useState(false);
  const [reverseSubmitBusy, setReverseSubmitBusy] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState('');
  const [uploadBusy, setUploadBusy] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState('');
  const [visibleCount, setVisibleCount] = useState(30);
  const [previewAsset, setPreviewAsset] = useState<ReferenceAsset | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const selection = useMemo(() => resolveWorkbenchImageApi(state.settings, 'ordinary'),
    [state.settings.imageApi, state.settings.imageApiProfiles, state.settings.activeImageApiProfileId]);
  const resolvedSize = useMemo(() => resolveImageOutputSize(draft.sizePreference, { width: 1024, height: 1024 }, selection.config, 'reference'),
    [draft.sizePreference, selection.config]);
  const rules = state.imagePromptRules.ruleSets.filter(rule => rule.enabled);
  const selectedRule = rules.find(rule => rule.id === draft.ruleSetId);
  const ruleIssue = useMemo(() => {
    if (draft.promptMode !== 'rules') return '';
    try { captureCustomImageRule(state.imagePromptRules.ruleSets, draft.ruleSetId || '', selection.config); return ''; }
    catch (error) { return error instanceof Error ? error.message : '所选生图规则不可用。'; }
  }, [draft.promptMode, draft.ruleSetId, state.imagePromptRules.ruleSets, selection.config]);
  const configProblem = selection.config.backend === 'runninghub'
    ? validateRunningHubImageConfig(selection.config, draft.referenceAssetIds.length) || '' : '';
  const apiIssue = selection.issue || (!selection.config.enabled ? '请在 API 设置中启用生图接口。' : '') || configProblem;
  const textIssue = draft.promptMode === 'rules' && (!state.settings.textApi.enabled || !state.settings.textApi.model.trim() || !state.settings.textApi.baseUrl.trim())
    ? '使用规则转换需要配置并启用文本 API。' : '';
  const issue = apiIssue || resolvedSize.issue || ruleIssue || textIssue;
  const vision = state.settings.visionApi;
  const reverseIssue = !vision.enabled || !vision.vision || !vision.baseUrl.trim() || !vision.model.trim()
    ? '请在 API 设置中配置并启用视觉识别 API。' : '';
  const allTasks = state.project.generationTasks.filter((task): task is ImageGenerationTask | ImagePromptReverseTask =>
    task.kind === 'image-prompt-reverse' || task.kind === 'image' && task.assetKind === 'custom')
    .slice().sort((a, b) => a.createdAt - b.createdAt);
  const tasks = allTasks.slice(-visibleCount);
  const lastTask = tasks[tasks.length - 1];
  const availableImages = state.project.assets.filter(asset => !asset.missing && asset.mediaType !== 'video' && asset.mediaType !== 'audio'
    && asset.type !== 'video' && asset.type !== 'audio' && Boolean(assetPreviewUrl(asset)));
  const draftAssets = draft.referenceAssetIds.map(id => state.project.assets.find(asset => asset.id === id));
  const reverseAssets = draftAssets.filter((asset): asset is ReferenceAsset => Boolean(asset && availableImages.some(available => available.id === asset.id)));
  const reverseActive = allTasks.some(task => task.kind === 'image-prompt-reverse' && (task.status === 'queued' || task.status === 'running'));

  function patchDraft(patch: Partial<CustomImageDraft>) {
    context.updateBackground(current => applyOwnedProjectUpdate(current, projectId, project => ({
      ...project, customImageDraft: { ...(project.customImageDraft || defaultCustomImageDraft()), ...patch },
    })));
  }

  useEffect(() => {
    if (history.current) history.current.scrollTop = history.current.scrollHeight;
  }, [lastTask?.id, lastTask?.status, lastTask?.kind === 'image' ? lastTask.resultAssetId : undefined]);
  useEffect(() => {
    if (!focusReverseTaskId) return;
    const index = allTasks.findIndex(task => task.kind === 'image-prompt-reverse' && task.id === focusReverseTaskId);
    if (index < 0) { onReverseFocusHandled?.(); return; }
    const needed = allTasks.length - index;
    if (needed > visibleCount) { setVisibleCount(needed); return; }
    const article = history.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(focusReverseTaskId)}"]`);
    if (!article) return;
    article.scrollIntoView({ block: 'center' });
    article.focus({ preventScroll: true });
    onReverseFocusHandled?.();
  }, [focusReverseTaskId, visibleCount, projectId, allTasks, onReverseFocusHandled]);
  useEffect(() => { setReversePickerOpen(false); setPickerOpen(false); setPendingPrompt(''); }, [projectId]);
  useEffect(() => {
    if (!previewAsset) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreviewAsset(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [previewAsset]);
  useEffect(() => {
    if (!pendingPrompt) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setPendingPrompt(''); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [pendingPrompt]);

  async function uploadReferences(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    setUploadBusy(true);
    try {
      for (const file of files) {
        const dataUrl = await readImageAsDataUrl(file, Number.POSITIVE_INFINITY);
        const managed = context.storeImage ? await context.storeImage({ dataUrl, fileName: file.name }) : undefined;
        const local = buildLocalReferenceAsset({ id: createId('asset'), fileName: file.name, dataUrl, mimeType: referenceImageMimeType(dataUrl), role: 'composition' });
        const asset: ReferenceAsset = { ...local, ...(managed || {}), dataUrl: managed ? undefined : dataUrl,
          referenceRole: 'general', referenceScope: 'general', tags: [...local.tags, '自定义生图参考'], missing: false };
        context.updateBackground(current => applyOwnedProjectUpdate(current, projectId, project => {
          const currentDraft = project.customImageDraft || defaultCustomImageDraft();
          return { ...project, assets: [asset, ...project.assets], customImageDraft: {
            ...currentDraft, referenceAssetIds: [...currentDraft.referenceAssetIds, asset.id],
          } };
        }));
      }
    } catch (error) {
      context.notify(getSafeErrorDiagnostics(error).message, 'error');
    } finally { setUploadBusy(false); }
  }

  async function send() {
    if (submitBusy || uploadBusy || !draft.userPrompt.trim() || issue) return;
    const submittedPrompt = draft.userPrompt;
    setSubmitBusy(true);
    try {
      const taskId = await submitCustomImage(context, {
        userPrompt: submittedPrompt, referenceAssetIds: draft.referenceAssetIds,
        sizePreference: draft.sizePreference, promptMode: draft.promptMode, ruleSetId: draft.ruleSetId,
      });
      if (taskId) context.updateBackground(current => applyOwnedProjectUpdate(current, projectId, project => {
        const currentDraft = project.customImageDraft;
        return currentDraft?.userPrompt === submittedPrompt
          ? { ...project, customImageDraft: { ...currentDraft, userPrompt: '' } } : project;
      }));
    } catch (error) { context.notify(getSafeErrorDiagnostics(error).message, 'error'); }
    finally { setSubmitBusy(false); }
  }

  async function retry(task: ImageGenerationTask) {
    if (actionBusy) return;
    setActionBusy(task.id);
    try {
      if (task.customImageSavePending) await retryCustomImageSave(context, task);
      else await retryCustomImageTask(context, task);
    } catch (error) { context.notify(getSafeErrorDiagnostics(error).message, 'error'); }
    finally { setActionBusy(''); }
  }

  function edit(task: ImageGenerationTask, reconvert = false) {
    patchDraft({ userPrompt: task.customImageInput?.userPrompt || task.prompt,
      referenceAssetIds: [...(task.referenceAssetIds || [])],
      sizePreference: { mode: 'custom', aspect: '1:1', width: task.width, height: task.height, resolutionVersion: 1 },
      promptMode: reconvert ? 'rules' : task.customImageInput?.promptMode || 'raw',
      ruleSetId: task.customImageInput?.ruleSelection?.id || draft.ruleSetId || rules[0]?.id,
    });
    promptInput.current?.focus();
  }

  function stopImage(task: ImageGenerationTask) {
    const current = context.getState();
    const owner = current.project.id === projectId ? current.project : current.projects.find(project => project.id === projectId);
    const live = owner?.generationTasks.find(candidate => candidate.id === task.id);
    if (!live || live.kind !== 'image' || live.createdAt !== task.createdAt
      || (live.status !== 'queued' && live.status !== 'running')) return;
    const running = live.status === 'running';
    if (running ? !forceStopImageTask(projectId, live) : !revokeQueuedGenerationTask(projectId, live)) return;
    context.updateBackground(state => applyOwnedProjectUpdate(state, projectId, project => {
      const candidate = project.generationTasks.find(item => item.id === task.id);
      if (!candidate || candidate.kind !== 'image' || candidate.createdAt !== task.createdAt) return project;
      const result = running ? forceStopImageGenerationTask(project.generationTasks, task.id)
        : cancelQueuedGenerationTask(project.generationTasks, task.id);
      return { ...project, generationTasks: result.tasks };
    }));
    context.notify(running ? '已强制停止此生图任务，队列继续；迟到结果不再保存。服务端可能仍在生成或计费。'
      : '已取消此排队任务，其他任务继续。');
  }

  async function reverseImage(referenceAssetId: string) {
    if (reverseSubmitBusy || uploadBusy || reverseActive || reverseIssue) return;
    setReversePickerOpen(false);
    setReverseSubmitBusy(true);
    try { await submitImagePromptReverse(context, { referenceAssetId, customRequirement: draft.userPrompt }); }
    catch (error) { context.notify(getSafeErrorDiagnostics(error).message, 'error'); }
    finally { setReverseSubmitBusy(false); }
  }

  async function reverseAction(task: ImagePromptReverseTask, action: 'stop' | 'retry') {
    if (actionBusy) return;
    setActionBusy(task.id);
    try {
      if (action === 'stop') await stopImagePromptReverse(context, task);
      else await retryImagePromptReverse(context, task);
    } catch (error) { context.notify(getSafeErrorDiagnostics(error).message, 'error'); }
    finally { setActionBusy(''); }
  }

  function deleteReverse(task: ImagePromptReverseTask) {
    context.updateBackground(current => applyOwnedProjectUpdate(current, projectId, project => ({
      ...project, generationTasks: project.generationTasks.filter(item => item.kind !== 'image-prompt-reverse'
        || item.id !== task.id || item.status === 'queued' || item.status === 'running'),
    })));
  }

  async function copyReverse(value: string) {
    try { await navigator.clipboard.writeText(value); context.notify('已复制。'); }
    catch { context.notify('复制失败，请选中分析内容手动复制。', 'error'); }
  }

  function fillPrompt(value: string) {
    const latest = context.getState();
    const project = latest.project.id === projectId ? latest.project : latest.projects.find(item => item.id === projectId);
    if (project?.customImageDraft?.userPrompt.trim()) { setPendingPrompt(value); return; }
    patchDraft({ userPrompt: value });
    promptInput.current?.focus();
  }

  function applyPendingPrompt(append: boolean) {
    context.updateBackground(current => applyOwnedProjectUpdate(current, projectId, project => {
      const currentDraft = project.customImageDraft || defaultCustomImageDraft();
      return { ...project, customImageDraft: { ...currentDraft,
        userPrompt: append && currentDraft.userPrompt.trim() ? `${currentDraft.userPrompt}\n\n${pendingPrompt}` : pendingPrompt } };
    }));
    setPendingPrompt('');
    promptInput.current?.focus();
  }

  return <div className="custom-image-panel">
    <div className="custom-image-history" ref={history} role="log" aria-label="自定义生图与图片反推记录" aria-live="polite" aria-relevant="additions">
      {!tasks.length && <div className="custom-image-empty"><MessageSquare size={28} /><strong>描述你想生成的图片，或上传图片反推提示词</strong><span>生图结果自动保存到资产库，反推分析会显示在这里和资料任务中。</span></div>}
      {allTasks.length > visibleCount && <button className="btn small ghost" onClick={() => setVisibleCount(count => count + 30)}>显示更早的记录</button>}
      {tasks.map(task => {
        if (task.kind === 'image-prompt-reverse') {
          const snapshots = task.referenceAssetSnapshots.length ? imageReferenceSnapshotAssets(task.referenceAssetSnapshots) : [];
          const reference = snapshots.find(asset => asset.id === task.referenceAssetId)
            || state.project.assets.find(asset => asset.id === task.referenceAssetId);
          const active = task.status === 'queued' || task.status === 'running';
          return <article className="custom-image-turn custom-image-reverse-turn" key={task.id} data-task-id={task.id} tabIndex={-1}>
            <div className="custom-image-user">
              <div className="custom-image-user-text">反推图片提示词{task.customRequirement ? `\n关注要求：${task.customRequirement}` : ''}</div>
              <div className="custom-image-message-references"><ImagePromptReverseReferencePreview asset={reference}
                readManagedImageDataUrl={context.loader.readManagedImageDataUrl} onPreview={setPreviewAsset} /></div>
              <div className="custom-image-meta">视觉识别 · {task.model}{task.width && task.height ? ` · 原图 ${task.width}×${task.height}` : ''}</div>
            </div>
            <div className="custom-image-result">
              <div className={`custom-image-status ${task.status === 'failed' ? 'failed' : task.status === 'succeeded' ? 'succeeded' : ''}`}>
                {task.preparationStage === 'reference' && active ? '正在读取反推原图…' : imagePromptReverseStatusLabel(task.status)}
                <span className="custom-image-meta">{task.name}</span>
              </div>
              {task.result && <ImagePromptReverseResultView result={task.result} />}
              {task.error && <div className="custom-image-error" role="alert">{task.error}</div>}
              <div className="row wrap custom-image-result-actions">
                {task.result && <><button className="btn small" onClick={() => void copyReverse(task.result!.prompt)}><Copy size={14} />复制提示词</button>
                  <button className="btn small ghost" onClick={() => void copyReverse(formatImagePromptReverseResult(task.result!))}>复制全部</button>
                  <button className="btn small" onClick={() => fillPrompt(task.result!.prompt)}>填入自定义要求</button></>}
                {active ? <button className="btn small ghost" disabled={Boolean(actionBusy)} onClick={() => void reverseAction(task, 'stop')}><Square size={13} />停止分析</button>
                  : <>{(task.status === 'failed' || task.status === 'cancelled') && <button className="btn small" disabled={Boolean(actionBusy) || reverseActive} onClick={() => void reverseAction(task, 'retry')}><RefreshCw size={14} />重试反推</button>}
                    <button className="btn small ghost" disabled={Boolean(actionBusy)} onClick={() => deleteReverse(task)}><Trash2 size={14} />删除记录</button></>}
              </div>
            </div>
          </article>;
        }
        const result = state.project.assets.find(asset => asset.id === task.resultAssetId);
        const preview = result ? assetPreviewUrl(result) : task.customImageSavePending ? task.resultUrl : '';
        const snapshots = task.referenceAssetSnapshots?.length ? imageReferenceSnapshotAssets(task.referenceAssetSnapshots) : [];
        const referenceAssets = (task.referenceAssetIds || []).map(id => state.project.assets.find(asset => asset.id === id) || snapshots.find(asset => asset.id === id));
        const active = task.status === 'queued' || task.status === 'running';
        const familyActive = allTasks.some(item => item.kind === 'image' && (item.regenerationRootTaskId || item.id) === (task.regenerationRootTaskId || task.id)
          && (item.status === 'queued' || item.status === 'running'));
        return <article className="custom-image-turn" key={task.id} data-task-id={task.id}>
          <div className="custom-image-user">
            <div className="custom-image-user-text">{task.customImageInput?.userPrompt || task.prompt}</div>
            {referenceAssets.length > 0 && <div className="custom-image-message-references">{referenceAssets.map((asset, index) => <span key={`${task.id}-${index}`}>
              {asset && assetPreviewUrl(asset) && <img src={assetPreviewUrl(asset)} alt="" loading="lazy" />}参考图 {index + 1}
            </span>)}</div>}
            <div className="custom-image-meta">{task.customImageInput?.promptMode === 'rules' ? `规则转换 · ${task.customImageInput.ruleSelection?.name || '已保存规则'}` : '原文直发'} · {task.width}×{task.height} · {task.model}</div>
          </div>
          <div className="custom-image-result">
            <div className={`custom-image-status ${task.status === 'failed' ? 'failed' : task.status === 'succeeded' ? 'succeeded' : ''}`}>
              {task.status === 'succeeded' ? '已保存到资产库' : task.customImageSavePending ? '图片已生成，保存未完成' : task.preparationStage === 'prompt-convert' ? '正在转换提示词' : imageGenerationStatusLabel(task.status)}
              <span className="custom-image-meta">{task.name}</span>
            </div>
            {preview && <button className="custom-image-preview" aria-label={`预览${task.name}`} onClick={() => result && setPreviewAsset(result)} disabled={!result}>
              <img src={preview} alt={task.name} loading="lazy" />
            </button>}
            {task.error && <div className="custom-image-error" role="alert">{task.error}</div>}
            {task.bindingWarning && <div className="field-hint">{task.bindingWarning}</div>}
            {task.prompt && <details className="custom-image-prompt-details"><summary>查看实际生图提示词{task.customImageInput?.promptMode === 'rules' ? '与规则' : ''}</summary>
              <pre>{task.prompt}</pre>{task.customImageInput?.ruleSelection && <div className="custom-image-meta">{task.customImageInput.ruleSelection.name} · v{task.customImageInput.ruleSelection.ruleVersion}</div>}
            </details>}
            <div className="row wrap custom-image-result-actions">
              {result && <><button className="btn small" onClick={() => { patchDraft({ referenceAssetIds: [...new Set([...draft.referenceAssetIds, result.id])] }); promptInput.current?.focus(); }}><ImagePlus size={14} />用这张继续改</button>
                <button className="btn small ghost" onClick={onOpenAssets}><Library size={14} />查看资产</button></>}
              {active && <button className="btn small danger" onClick={() => stopImage(task)}
                title={task.status === 'running' ? '立即停止本地等待并释放队列，迟到结果不再保存；服务端可能仍在生成或计费' : '取消排队，保留任务记录'}>
                <Square size={13} />{task.status === 'running' ? '强制停止' : '取消排队'}</button>}
              {!active && <><button className="btn small" disabled={Boolean(actionBusy) || familyActive} onClick={() => void retry(task)}><RefreshCw size={14} />{task.customImageSavePending ? '重试保存' : task.prompt ? '按原提示词再生成' : '重试规则转换'}</button>
                <button className="btn small ghost" disabled={Boolean(actionBusy)} onClick={() => edit(task)}>编辑要求</button>
                {task.customImageInput?.promptMode === 'rules' && <button className="btn small ghost" onClick={() => edit(task, true)}>重新选择规则转换</button>}</>}
            </div>
          </div>
        </article>;
      })}
    </div>
    <div className="custom-image-composer">
      {draft.referenceAssetIds.length > 0 && <div className="custom-image-attachments">{draftAssets.map((asset, index) => <div className="custom-image-attachment" key={draft.referenceAssetIds[index]}>
        {asset && assetPreviewUrl(asset) && <img src={assetPreviewUrl(asset)} alt="" />}<span>{asset?.name || '参考图已删除，请移除或重新选择'}</span>
        <button aria-label={`移除参考图${index + 1}`} onClick={() => patchDraft({ referenceAssetIds: draft.referenceAssetIds.filter((_, offset) => offset !== index) })}><X size={13} /></button>
      </div>)}</div>}
      <label htmlFor={`custom-image-prompt-${projectId}`}>自定义要求</label>
      <textarea id={`custom-image-prompt-${projectId}`} ref={promptInput} value={draft.userPrompt} aria-label="自定义生图要求" placeholder="描述生图或修改要求；反推时可填写关注重点，也可留空。Ctrl+Enter 发送并生图。"
        onChange={event => patchDraft({ userPrompt: event.target.value })} onKeyDown={event => { if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); void send(); } }} />
      <div className="row wrap custom-image-reference-actions"><button className="btn small" disabled={uploadBusy} onClick={() => fileInput.current?.click()}><Upload size={14} />{uploadBusy ? '正在上传…' : '上传参考图'}</button>
        <button className="btn small" disabled={uploadBusy} onClick={() => setPickerOpen(true)}><Library size={14} />从资产库选择</button>
        <button className="btn small" disabled={uploadBusy || reverseSubmitBusy || reverseActive || !reverseAssets.length || Boolean(reverseIssue)}
          title={!draft.referenceAssetIds.length ? '请先上传或选择参考图。' : !reverseAssets.length ? '参考图已删除或不可用，请重新选择。' : reverseIssue || (reverseActive ? '当前图片反推正在进行，可在聊天区或资料任务中停止。' : '使用视觉 API 详细识别选中的原图。')}
          onClick={() => { if (reverseAssets.length === 1) void reverseImage(reverseAssets[0].id); else setReversePickerOpen(true); }}><ScanSearch size={14} />{reverseSubmitBusy ? '正在提交…' : '反推图片提示词'}</button>
        <span className="field-hint">本次参考图 {draft.referenceAssetIds.length} 张 · 每次生成 1 张</span>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden aria-label="上传自定义生图参考图" onChange={event => void uploadReferences(event)} />
      </div>
    </div>
    <div className="custom-image-controls">
      <div className="custom-image-settings">
        <ImageOutputSizeControls lane="custom" variant="reference" value={draft.sizePreference} resolved={resolvedSize} disabled={submitBusy}
          capabilityNote="按当前生图模型和协议提交所选尺寸，实际像素以返回图片为准。" onChange={sizePreference => patchDraft({ sizePreference })} />
        <div className="custom-image-rule-controls">
          <label className="check-row"><input type="checkbox" checked={draft.promptMode === 'rules'} onChange={event => patchDraft({ promptMode: event.target.checked ? 'rules' : 'raw', ruleSetId: draft.ruleSetId || rules[0]?.id })} />使用规则转换 <span className="field-hint">可选</span></label>
          {draft.promptMode === 'rules' && <div className="custom-image-rule-picker"><label htmlFor={`custom-image-rule-${projectId}`}>生图规则</label>
            <select id={`custom-image-rule-${projectId}`} aria-label="自定义生图规则" value={draft.ruleSetId || ''} onChange={event => patchDraft({ ruleSetId: event.target.value })}>
              {!selectedRule && <option value={draft.ruleSetId || ''}>{draft.ruleSetId ? '所选规则已删除或停用，请重新选择' : '请选择生图规则'}</option>}
              {rules.map(rule => <option key={rule.id} value={rule.id} disabled={selection.config.backend === 'novelai' && rule.format !== 'nai-tags'}>{rule.name} · v{rule.version}</option>)}
            </select><button className="btn small ghost" onClick={onManageRules}><BookOpen size={14} />管理规则</button>
          </div>}
        </div>
      </div>
      <div className="custom-image-send-row"><div className="custom-image-send-note"><span>{draft.promptMode === 'raw' ? '原文直接提交生图模型' : '按所选规则转换后生图'}</span><span className="field-hint">{imageApiChoiceLabel(selection.config)}</span></div>
        <button className="btn primary" disabled={submitBusy || uploadBusy || !draft.userPrompt.trim() || Boolean(issue)} onClick={() => void send()}><Send size={16} />{submitBusy ? '正在提交…' : '发送并生图'}</button>
      </div>
      {issue && <div className="custom-image-error" role="alert">{issue}</div>}
    </div>
    <ReferenceImagePickerModal open={reversePickerOpen} assets={reverseAssets} selectedAssetId={reverseAssets[0]?.id || ''}
      busy={reverseSubmitBusy} title="选择要反推的图片" hint="从本次参考图中选择一张，识别结果将显示在聊天区和资料任务中。" confirmLabel="反推所选图片"
      onClose={() => setReversePickerOpen(false)} onConfirm={asset => void reverseImage(asset.id)} />
    <ReferenceImagePickerModal open={pickerOpen} assets={availableImages} selectedAssetId="" onClose={() => setPickerOpen(false)} onConfirm={asset => { patchDraft({ referenceAssetIds: [...new Set([...draft.referenceAssetIds, asset.id])] }); setPickerOpen(false); }} />
    {pendingPrompt && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setPendingPrompt(''); }}>
      <div className="modal custom-image-fill-modal" role="dialog" aria-modal="true" aria-label="填入反推提示词">
        <div className="modal-head"><h3>填入反推提示词</h3><button className="btn small ghost" onClick={() => setPendingPrompt('')}>关闭</button></div>
        <p>自定义要求中已有草稿，请选择如何填入。</p>
        <div className="row wrap"><button className="btn primary" onClick={() => applyPendingPrompt(true)}>追加到现有要求</button>
          <button className="btn" onClick={() => applyPendingPrompt(false)}>替换现有要求</button>
          <button className="btn ghost" onClick={() => setPendingPrompt('')}>取消</button></div>
      </div>
    </div>}
    {previewAsset && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setPreviewAsset(null); }}><div className="modal asset-preview-modal" role="dialog" aria-modal="true" aria-label="自定义生图与反推原图预览">
      <div className="modal-head"><h3>{previewAsset.name}</h3><button className="btn small ghost" onClick={() => setPreviewAsset(null)}>关闭</button></div><AssetImagePreview src={assetPreviewUrl(previewAsset)} alt={previewAsset.name} />
    </div></div>}
  </div>;
}
