import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Check, X } from 'lucide-react';
import { CHARACTER_DOSSIER_FIELDS, previewCharacterDossierApplication, type CharacterDossierApplicationOptions, type CharacterDossierField } from '../characterDossierApplication';
import type { Project } from '../types';
import './CharacterDossierApplyDialog.css';

export interface CharacterDossierApplyDialogProps {
  project: Project;
  sourceCharacterId: string;
  onClose: () => void;
  onApply: (options: CharacterDossierApplicationOptions) => void;
}

export function CharacterDossierApplyDialog({ project, sourceCharacterId, onClose, onApply }: CharacterDossierApplyDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onClose, onApply });
  callbacks.current = { onClose, onApply };
  const [targetCharacterId, setTargetCharacterId] = useState('');
  const [mode, setMode] = useState<'copy' | 'transfer'>('copy');
  const [fields, setFields] = useState<CharacterDossierField[]>(() => CHARACTER_DOSSIER_FIELDS.map((field) => field.key));
  const [clearEmpty, setClearEmpty] = useState(false);
  const [applyReferenceImages, setApplyReferenceImages] = useState(false);
  const [applyError, setApplyError] = useState('');
  const source = project.characters.find((character) => character.id === sourceCharacterId);
  const targets = project.characters.filter((character) => character.id !== sourceCharacterId && !character.dossier?.archivedIntoCharacterId);
  const target = targets.find((character) => character.id === targetCharacterId);
  const options = useMemo<CharacterDossierApplicationOptions>(() => ({ sourceCharacterId, targetCharacterId, mode, fields, clearEmpty, applyReferenceImages }), [sourceCharacterId, targetCharacterId, mode, fields, clearEmpty, applyReferenceImages]);
  const result = useMemo(() => {
    if (!targetCharacterId) return { preview: undefined, error: '' };
    try { return { preview: previewCharacterDossierApplication(project, options), error: '' }; }
    catch (error) { return { preview: undefined, error: error instanceof Error ? error.message : '无法预览人物资料应用，请重新选择目标。' }; }
  }, [project, options, targetCharacterId]);
  const preview = result.preview;
  const hasSourceText = Boolean(source && CHARACTER_DOSSIER_FIELDS.some(({ key }) => String(source[key] ?? '').trim()));
  const sourceImageCount = project.assets.filter((asset) => source?.assetIds.includes(asset.id)
    && (!asset.mediaType || asset.mediaType === 'image') && ['character', 'reference'].includes(asset.type)
    && asset.referenceScope !== 'nsfw-private-profile' && !asset.nsfwPrivatePart && !asset.imageVariant?.startsWith('private-')).length;
  const changedFields = new Set(preview?.changes.map((change) => change.field));
  const hasChange = mode === 'transfer' || Boolean(preview?.changes.length) || (applyReferenceImages && Boolean(preview?.referenceAssetIds.length));
  const canApply = Boolean(source && target && preview && !result.error && (hasSourceText || (applyReferenceImages && sourceImageCount > 0)) && hasChange);
  const toggleField = (field: CharacterDossierField) => setFields((current) => current.includes(field) ? current.filter((item) => item !== field) : [...current, field]);

  useEffect(() => { setApplyError(''); }, [options]);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].filter((element) => element.getClientRects().length > 0);
      if (dialogs[dialogs.length - 1] !== dialog) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); callbacks.current.onClose(); return; }
      if (event.key !== 'Tab') return;
      const elements = [...(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') || [])].filter((element) => element.getClientRects().length > 0);
      const first = elements[0]; const last = elements[elements.length - 1];
      if (!first || !last) { event.preventDefault(); dialog?.focus(); }
      else if (!dialog?.contains(document.activeElement) || document.activeElement === dialog) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => { document.removeEventListener('keydown', onKeyDown, true); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  const dialog = <div className="cda-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} className="cda-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className="cda-header"><div><h2 id={titleId}>应用到剧情人物</h2><p>使用已保存的自建资料，先核对字段和影响范围。</p></div><button type="button" className="btn small" aria-label="关闭人物资料应用" onClick={onClose}><X size={16} />关闭</button></header>
      <div className="cda-content">
        <div className="cda-identity"><div><span>自建资料</span><strong>{source?.name || '人物已不存在'}</strong></div><ArrowRight size={20} aria-hidden="true" /><label><span>应用到哪个剧情人物</span><select aria-label="目标剧情人物" value={targetCharacterId} onChange={(event) => setTargetCharacterId(event.target.value)}><option value="">请选择一个人物／形态</option>{targets.map((character) => <option key={character.id} value={character.id}>{character.name}{character.formLabel && !character.name.includes(character.formLabel) ? ` · ${character.formLabel}` : ''}</option>)}</select></label></div>
        {targets.length === 0 && <p className="cda-notice">当前项目没有其他可应用的人物，请先建立或解析剧情人物。</p>}
        <fieldset className="cda-modes"><legend>应用方式</legend><label className={mode === 'copy' ? 'selected' : ''}><input type="radio" name={`${titleId}-mode`} value="copy" checked={mode === 'copy'} onChange={() => setMode('copy')} /><span><strong>覆盖资料，保留原绑定（推荐）</strong><small>一次复制；之后修改自建资料不会自动同步。</small></span></label><label className={mode === 'transfer' ? 'selected' : ''}><input type="radio" name={`${titleId}-mode`} value="transfer" checked={mode === 'transfer'} onChange={() => setMode('transfer')} /><span><strong>将剧情绑定转给自建人物</strong><small>自建人物接管关联，后续生成使用这份人物资料。</small></span></label></fieldset>
        <p className="cda-hint">只处理选中的人物形态；保留目标的剧情名称和形态。资料管理名称不替换剧情对白。</p>
        <div className="cda-options"><label><input type="checkbox" checked={clearEmpty} onChange={(event) => setClearEmpty(event.target.checked)} />允许选中的空白字段清空原值</label><label><input type="checkbox" checked={applyReferenceImages} disabled={!sourceImageCount} onChange={(event) => setApplyReferenceImages(event.target.checked)} />同时使用自建人物参考图（{sourceImageCount} 张）</label></div>
        <p className="cda-hint">默认空白字段保留原值。未生图也可应用文字资料；替换参考图后，旧图片仍保留在资产库。</p>
        <div className="cda-fields-heading"><strong>选择要应用的资料字段</strong><div><button type="button" className="btn small" onClick={() => setFields(CHARACTER_DOSSIER_FIELDS.map((field) => field.key))}>全选</button><button type="button" className="btn small" onClick={() => setFields([])}>全不选</button></div></div>
        <div className="cda-table-wrap"><table className="cda-fields"><thead><tr><th scope="col">应用字段</th><th scope="col">目标当前资料</th><th scope="col">应用后资料</th></tr></thead><tbody>{CHARACTER_DOSSIER_FIELDS.map(({ key, label }) => {
          const selected = fields.includes(key);
          const before = String(target?.[key] ?? '');
          const sourceValue = String(source?.[key] ?? '');
          const after = selected && (sourceValue.trim() || clearEmpty) ? sourceValue : before;
          return <tr key={key} data-dossier-field={key} className={changedFields.has(key) ? 'cda-changed' : ''}><th scope="row"><label><input type="checkbox" checked={selected} onChange={() => toggleField(key)} />{label}</label></th><td>{before || <span className="cda-empty">空白</span>}</td><td>{after || <span className="cda-empty">空白</span>}{selected && !sourceValue.trim() && !clearEmpty && <small className="cda-retain">自建资料为空，保留原值</small>}</td></tr>;
        })}</tbody></table></div>
        {preview && <section className="cda-impact" aria-label="应用影响范围"><strong>本次影响范围</strong><p>{preview.changes.length} 项资料变化 · {preview.affectedSceneIds.length} 个场景 · {preview.affectedStoryboardIds.length} 组分镜 · {preview.affectedSegmentIds.length} 个长剧情段落</p><p>{applyReferenceImages ? `使用自建人物的 ${preview.referenceAssetIds.length} 张参考图。` : '保留当前参考图设置。'} 受影响的已有提示词标记为待刷新，原稿保留。</p>{preview.warnings.map((warning, index) => <p key={`${index}-${warning}`} className="cda-notice">{warning}</p>)}</section>}
        {!hasSourceText && <p className="cda-notice">自建人物尚无可应用的文字资料，请先补齐并保存；也可以选择已有参考图进行应用。</p>}
        {(result.error || applyError) && <p className="cda-error" role="alert">{applyError || result.error}</p>}
        {preview && !hasChange && <p className="cda-hint">所选字段与目标相同，没有需要应用的变化。</p>}
      </div>
      <footer className="cda-footer"><p>已有生成任务、图片和视频保留原记录；应用后可通过撤销恢复。</p><div><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!canApply} onClick={() => { if (!canApply) return; try { callbacks.current.onApply(options); } catch (error) { setApplyError(error instanceof Error ? error.message : '应用失败，请重试。'); } }}><Check size={16} />{mode === 'copy' ? '确认覆盖所选资料' : '确认转移绑定'}</button></div></footer>
    </div>
  </div>;
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
