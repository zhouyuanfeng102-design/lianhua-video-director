import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { BookOpen, ImagePlus, Library, MessageSquare, RefreshCw, Send, Upload, X } from 'lucide-react';
import type { AppState, CustomImageDraft, ImageGenerationTask, ReferenceAsset } from '../types';
import { applyOwnedProjectUpdate, buildLocalReferenceAsset } from '../appEffects';
import { createId, readImageAsDataUrl } from '../storage';
import { assetPreviewUrl } from '../media';
import { referenceImageMimeType } from '../imageReferenceData';
import { defaultImageOutputSize, resolveImageOutputSize } from '../imageOutputSize';
import { resolveWorkbenchImageApi, imageApiChoiceLabel } from '../imageApiSelection';
import { imageReferenceSnapshotAssets } from '../imageGeneration';
import { imageGenerationStatusLabel } from '../generationTasks';
import { captureCustomImageRule } from '../customImagePrompt';
import { submitCustomImage, retryCustomImageTask, retryCustomImageSave, type CustomImageGenerationContext } from '../customImageGeneration';
import { getSafeErrorDiagnostics } from '../errorDiagnostics';
import { ReferenceImagePickerModal } from './ReferenceImagePickerModal';
import { ImageOutputSizeControls } from './ImageOutputSizeControls';
import { AssetImagePreview } from './AssetImagePreview';
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
}

export function CustomImageWorkbenchPanel({ state, context, onOpenAssets, onManageRules }: Props) {
  const projectId = state.project.id;
  const draft = state.project.customImageDraft || defaultCustomImageDraft();
  const [pickerOpen, setPickerOpen] = useState(false);
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
  const apiIssue = selection.issue || (!selection.config.enabled ? '请在 API 设置中启用生图接口。' : '');
  const textIssue = draft.promptMode === 'rules' && (!state.settings.textApi.enabled || !state.settings.textApi.model.trim() || !state.settings.textApi.baseUrl.trim())
    ? '使用规则转换需要配置并启用文本 API。' : '';
  const issue = apiIssue || resolvedSize.issue || ruleIssue || textIssue;
  const allTasks = state.project.generationTasks.filter((task): task is ImageGenerationTask => task.kind === 'image' && task.assetKind === 'custom')
    .slice().sort((a, b) => a.createdAt - b.createdAt);
  const tasks = allTasks.slice(-visibleCount);
  const lastTask = tasks[tasks.length - 1];
  const availableImages = state.project.assets.filter(asset => !asset.missing && asset.mediaType !== 'video' && asset.mediaType !== 'audio'
    && asset.type !== 'video' && asset.type !== 'audio' && Boolean(assetPreviewUrl(asset)));
  const draftAssets = draft.referenceAssetIds.map(id => state.project.assets.find(asset => asset.id === id));

  function patchDraft(patch: Partial<CustomImageDraft>) {
    context.updateBackground(current => applyOwnedProjectUpdate(current, projectId, project => ({
      ...project, customImageDraft: { ...(project.customImageDraft || defaultCustomImageDraft()), ...patch },
    })));
  }

  useEffect(() => {
    if (history.current) history.current.scrollTop = history.current.scrollHeight;
  }, [lastTask?.id, lastTask?.status, lastTask?.resultAssetId]);
  useEffect(() => {
    if (!previewAsset) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreviewAsset(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [previewAsset]);

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

  return <div className="custom-image-panel">
    <div className="custom-image-history" ref={history} role="log" aria-label="自定义生图记录" aria-live="polite" aria-relevant="additions">
      {!tasks.length && <div className="custom-image-empty"><MessageSquare size={28} /><strong>描述你想生成的图片</strong><span>可以上传参考图，也可以只输入文字。生成结果自动保存到资产库。</span></div>}
      {allTasks.length > visibleCount && <button className="btn small ghost" onClick={() => setVisibleCount(count => count + 30)}>显示更早的记录</button>}
      {tasks.map(task => {
        const result = state.project.assets.find(asset => asset.id === task.resultAssetId);
        const preview = result ? assetPreviewUrl(result) : task.customImageSavePending ? task.resultUrl : '';
        const snapshots = task.referenceAssetSnapshots?.length ? imageReferenceSnapshotAssets(task.referenceAssetSnapshots) : [];
        const referenceAssets = (task.referenceAssetIds || []).map(id => state.project.assets.find(asset => asset.id === id) || snapshots.find(asset => asset.id === id));
        const active = task.status === 'queued' || task.status === 'running';
        const familyActive = allTasks.some(item => (item.regenerationRootTaskId || item.id) === (task.regenerationRootTaskId || task.id)
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
      <textarea id={`custom-image-prompt-${projectId}`} ref={promptInput} value={draft.userPrompt} aria-label="自定义生图要求" placeholder="直接描述想生成什么，或上传图片后描述修改要求。Ctrl+Enter 发送。"
        onChange={event => patchDraft({ userPrompt: event.target.value })} onKeyDown={event => { if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); void send(); } }} />
      <div className="row wrap"><button className="btn small" disabled={uploadBusy} onClick={() => fileInput.current?.click()}><Upload size={14} />{uploadBusy ? '正在上传…' : '上传参考图'}</button>
        <button className="btn small" disabled={uploadBusy} onClick={() => setPickerOpen(true)}><Library size={14} />从资产库选择</button>
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
    <ReferenceImagePickerModal open={pickerOpen} assets={availableImages} selectedAssetId="" onClose={() => setPickerOpen(false)} onConfirm={asset => { patchDraft({ referenceAssetIds: [...new Set([...draft.referenceAssetIds, asset.id])] }); setPickerOpen(false); }} />
    {previewAsset && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setPreviewAsset(null); }}><div className="modal asset-preview-modal" role="dialog" aria-modal="true" aria-label="自定义生成图片预览">
      <div className="modal-head"><h3>{previewAsset.name}</h3><button className="btn small ghost" onClick={() => setPreviewAsset(null)}>关闭</button></div><AssetImagePreview src={assetPreviewUrl(previewAsset)} alt={previewAsset.name} />
    </div></div>}
  </div>;
}
