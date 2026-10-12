import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, BookOpen, Brain, ImagePlus, Images, Link2, Upload, UserRound, X } from 'lucide-react';
import { assetPreviewUrl } from '../media';
import { comicSourceFingerprint, storyComicSettings } from '../comicSources';
import type { Project, StoryComicSettings, StoryImageSourceMode, StoryInputMode, StoryNarrator, StoryReference, StoryReferenceAnalysis, StoryReferenceSubject, StoryReferenceSubjectBinding } from '../types';
import { AssetImagePreview } from './AssetImagePreview';
import { ReferenceImagePickerModal } from './ReferenceImagePickerModal';
import './StoryReferencePanel.css';

export type StoryReferencePatch = Partial<Pick<StoryReference, 'enabled' | 'fullDescription' | 'notes' | 'subjectBindings' | 'sourceRole' | 'pageOrder'>>;
export type StoryNarratorBinding = { referenceId: string; subjectId: string } | StoryNarrator | undefined;

export interface StoryReferencePanelProps {
  project: Project;
  chapterId: string;
  uploading?: boolean;
  disabled?: boolean;
  onUpload: (file: File, sourceRole?: 'reference' | 'comic') => void | Promise<void>;
  onAddAsset: (assetId: string, sourceRole?: 'reference' | 'comic') => void | Promise<void>;
  onRecognize: (referenceId: string) => void | Promise<void>;
  onUpdateReference: (referenceId: string, patch: StoryReferencePatch) => void;
  onRemoveReference: (referenceId: string) => void;
  onInsertReference: (text: string) => void;
  onBindNarrator: (binding: StoryNarratorBinding) => void;
  onSetImageSourceMode: (mode: StoryImageSourceMode) => void;
  onSetComicSettings: (patch: Partial<StoryComicSettings>) => void;
  onMoveComicPage: (referenceId: string, direction: -1 | 1) => void;
  onGenerateComicStory: () => void | Promise<void>;
  comicGenerating?: boolean;
  onUpdateComicStory: (text: string) => void;
  onAdoptComicStory: () => void;
  onCreateComicPanelReference: (referenceId: string, panelId: string) => void | Promise<void>;
  onCancelComicGeneration: () => void;
}

export function StoryInputModeSwitch({ value, onChange, disabled = false }: {
  value: StoryInputMode; onChange: (mode: StoryInputMode) => void; disabled?: boolean;
}) {
  return <div className="story-input-mode-switch" role="group" aria-label="本章视频创作方式">
    <button type="button" className={'btn small ' + (value === 'text' ? 'primary' : 'ghost')} aria-pressed={value === 'text'} disabled={disabled} onClick={() => onChange('text')}><BookOpen size={16} />文生视频</button>
    <button type="button" className={'btn small ' + (value === 'image' ? 'primary' : 'ghost')} aria-pressed={value === 'image'} disabled={disabled} onClick={() => onChange('image')}><Images size={16} />图生视频</button>
  </div>;
}

type SubjectKind = StoryReferenceSubjectBinding['kind'];
const kindLabels: Record<SubjectKind, string> = { character: '人物', location: '地点', prop: '道具' };
const subjectGroups = (analysis?: StoryReferenceAnalysis): Array<{ kind: SubjectKind; subjects: StoryReferenceSubject[] }> => [
  { kind: 'character', subjects: analysis?.characters || [] },
  { kind: 'location', subjects: analysis?.locations || [] },
  { kind: 'prop', subjects: analysis?.props || [] },
];
const subjectName = (reference: StoryReference, subject: StoryReferenceSubject): string => reference.subjectBindings.find((binding) => binding.subjectId === subject.id)?.name || subject.label;
const referenceLabel = (reference: StoryReference, subject: StoryReferenceSubject): string => '图' + reference.number + '·' + subjectName(reference, subject);
const entityList = (project: Project, kind: SubjectKind) => kind === 'character' ? project.characters.filter((item) => !item.dossier?.archivedIntoCharacterId) : kind === 'location' ? project.locations : project.props;
const localDate = (timestamp: number) => new Date(timestamp).toLocaleString('zh-CN', { hour12: false });

function ReferenceDialog({ title, onClose, children, className = '' }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const dialog = dialogRef.current;
    dialog?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const items = [...(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') || [])].filter((item) => item.getClientRects().length);
      const first = items[0]; const last = items[items.length - 1];
      if (!first || !last) { event.preventDefault(); dialog?.focus(); }
      else if (!dialog?.contains(document.activeElement) || document.activeElement === dialog) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown, true);
    return () => { document.removeEventListener('keydown', keydown, true); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return createPortal(<div className="modal-backdrop story-reference-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={'modal story-reference-modal ' + className} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <div className="modal-head"><h3 id={titleId}>{title}</h3><button type="button" className="btn small ghost" onClick={onClose} aria-label="关闭参考图窗口"><X size={16} />关闭</button></div>
      {children}
    </div>
  </div>, document.body);
}

const comicTextLabels = { dialogue: '对白', thought: '内心', narration: '旁白', sfx: '拟声', unknown: '类别不明' };

function ComicPanelEvidence({ analysis, disabled = false, onCreatePanelReference }: {
  analysis: StoryReferenceAnalysis; disabled?: boolean;
  onCreatePanelReference?: (panelId: string) => void | Promise<void>;
}) {
  const [cropping, setCropping] = useState<string>();
  const [cropError, setCropError] = useState('');
  const comic = analysis.comic;
  if (!comic) return null;
  const characterName = (id?: string) => id ? analysis.characters.find((subject) => subject.id === id)?.label || id : '说话人未确定';
  const crop = async (panelId: string) => {
    if (disabled || cropping || !onCreatePanelReference) return;
    setCropError(''); setCropping(panelId);
    try { await onCreatePanelReference(panelId); }
    catch (error) { setCropError(error instanceof Error ? error.message : '单格参考图生成失败，请重试。'); }
    finally { setCropping(undefined); }
  };
  return <section className="story-comic-evidence" aria-label="漫画图格识别资料">
    <h4>漫画图格与文字（{comic.panels.length} 格）</h4>
    <p className="field-hint">图格按阅读顺序排列。对白保留原文与中文对照；不确定的信息需结合原图确认。</p>
    {comic.uncertainties.length > 0 && <p className="story-reference-warning">本页不确定项：{comic.uncertainties.join('；')}</p>}
    {[...comic.panels].sort((a, b) => a.order - b.order).map((panel) => <details className="story-comic-panel-detail" key={panel.id} open>
      <summary>第 {panel.order} 格 · {panel.description || '画面描述待补充'}</summary>
      {panel.characterIds.length > 0 && <p>人物：{panel.characterIds.map((id) => characterName(id)).join('、')}</p>}
      {(panel.entryState || panel.exitState) && <div className="story-comic-panel-states"><p>起始状态：{panel.entryState || '未明确'}</p><p>结束状态：{panel.exitState || '未明确'}</p></div>}
      {panel.actions.length > 0 && <div className="story-comic-panel-actions"><strong>动作与结果</strong>{panel.actions.map((action) => <p key={action.id}>{action.actorId ? characterName(action.actorId) + '：' : ''}{action.action}{action.targetId ? ' · 对象：' + characterName(action.targetId) : ''}{action.result ? ' → ' + action.result : ''}{action.phase ? '（' + action.phase + '）' : ''}</p>)}</div>}
      {panel.texts.length > 0 ? <div className="story-comic-panel-texts">{panel.texts.map((item) => <div className="story-comic-text" key={item.id}>
        <strong>{comicTextLabels[item.type]} · {item.speakerId ? characterName(item.speakerId) : item.type === 'dialogue' || item.type === 'thought' ? '说话人未确定' : '—'}{item.language ? ' · ' + item.language : ''}</strong>
        <p className="story-reference-prose">原文：{item.text || '未读出文字'}</p>
        {item.chineseText && <p className="story-reference-prose">中文对照：{item.chineseText}</p>}
        {item.uncertainty && <p className="story-comic-uncertainty">不确定：{item.uncertainty}</p>}
      </div>)}</div> : <p className="field-hint">本格没有识别到文字。</p>}
      {panel.uncertainties.length > 0 && <p className="story-comic-uncertainty">本格不确定项：{panel.uncertainties.join('；')}</p>}
      {onCreatePanelReference && <button type="button" className="btn small ghost" disabled={disabled || Boolean(cropping) || !panel.bounds} onClick={() => void crop(panel.id)} title={panel.bounds ? '从漫画原图裁出本格，另存为视频参考；原页保留' : '没有可靠的图格边界，暂时不能裁图'}><ImagePlus size={13} />{cropping === panel.id ? '裁图中…' : '裁出本格作为视频参考'}</button>}
    </details>)}
    {cropError && <p className="story-reference-warning" role="alert">{cropError}</p>}
  </section>;
}

export function StoryReferenceAnalysisView({ analysis, disabled = false, onCreatePanelReference }: {
  analysis: StoryReferenceAnalysis; disabled?: boolean;
  onCreatePanelReference?: (panelId: string) => void | Promise<void>;
}) {
  const rows: Array<[string, string | string[]]> = [
    ['完整画面描述', analysis.description], ['事件与动作', analysis.events], ['关系与位置', analysis.relationships],
    ['风格', analysis.style], ['构图', analysis.composition], ['光线', analysis.lighting], ['色彩', analysis.colors],
    ['图片文字', analysis.readableText], ['不确定的信息', analysis.uncertainties],
  ];
  return <div className="story-reference-analysis">
    <ComicPanelEvidence analysis={analysis} disabled={disabled} onCreatePanelReference={onCreatePanelReference} />
    {rows.map(([label, content]) => <section key={label}><h4>{label}</h4><div className="story-reference-prose">{(Array.isArray(content) ? content.join('\n') : content) || '未识别到相关信息'}</div></section>)}
    {subjectGroups(analysis).map(({ kind, subjects }) => <section key={kind}><h4>{kindLabels[kind]}（{subjects.length}）</h4>
      {subjects.length ? subjects.map((subject) => <div className="story-reference-subject-detail" key={subject.id}><strong>{subject.label}</strong><p>{subject.description}</p>
        <dl>{Object.entries(subject.fields).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
      </div>) : <div className="field-hint">未识别到相关主体</div>}
    </section>)}
    {analysis.structuredData && <details><summary>查看原始完整识别资料</summary><pre className="story-reference-prose">{JSON.stringify(analysis.structuredData, null, 2)}</pre></details>}
  </div>;
}

function ReferenceEditor({ reference, project, references, initialTab, disabled, onClose, onUpdateReference, onCreatePanelReference }: {
  reference: StoryReference; project: Project; references: StoryReference[]; initialTab: 'details' | 'image'; onClose: () => void;
  disabled: boolean;
  onUpdateReference: StoryReferencePanelProps['onUpdateReference'];
  onCreatePanelReference?: (panelId: string) => void | Promise<void>;
}) {
  const [tab, setTab] = useState<'details' | 'bindings' | 'history' | 'image'>(initialTab);
  const [fullDescription, setFullDescription] = useState(reference.fullDescription || '');
  const [notes, setNotes] = useState(reference.notes || '');
  const [bindings, setBindings] = useState(reference.subjectBindings);
  const [linkedBindings, setLinkedBindings] = useState<Record<string, StoryReferenceSubjectBinding[]>>({});
  const [openedRevision] = useState(reference.analysis?.revision);
  const [openedReferenceRevisions] = useState(() => Object.fromEntries(references.map((item) => [item.id, item.analysis?.revision])));
  const stale = openedRevision !== reference.analysis?.revision || Object.keys(linkedBindings).some((id) => {
    const current = references.find((item) => item.id === id);
    return !current || current.status === 'recognizing' || current.analysis?.revision !== openedReferenceRevisions[id];
  });
  const asset = project.assets.find((item) => item.id === reference.assetId);
  const src = asset && assetPreviewUrl(asset);
  const busy = disabled || reference.status === 'recognizing';
  const editBinding = (subject: StoryReferenceSubject, kind: SubjectKind, patch: Partial<StoryReferenceSubjectBinding>) => {
    setBindings((current) => {
      const previous = current.find((item) => item.subjectId === subject.id);
      return [...current.filter((item) => item.subjectId !== subject.id), { ...previous, subjectId: subject.id, kind, ...patch }];
    });
  };
  const chooseBinding = (subject: StoryReferenceSubject, kind: SubjectKind, value: string) => {
    if (value.startsWith('entity:')) {
      const entityId = value.slice(7); const entity = entityList(project, kind).find((item) => item.id === entityId);
      editBinding(subject, kind, { entityId, name: entity?.name }); return;
    }
    if (value.startsWith('subject:')) {
      const [referenceId, subjectId] = value.slice(8).split('|');
      const other = references.find((item) => item.id === referenceId);
      const target = subjectGroups(other?.analysis).find((item) => item.kind === kind)?.subjects.find((item) => item.id === subjectId);
      if (!other || !target) return;
      const others = linkedBindings[other.id] || other.subjectBindings;
      const prior = others.find((item) => item.subjectId === target.id);
      const name = prior?.name || target.label;
      editBinding(subject, kind, { entityId: prior?.entityId, name });
      setLinkedBindings((current) => ({ ...current, [other.id]: [...others.filter((item) => item.subjectId !== target.id), { ...prior, subjectId: target.id, kind, name }] }));
      return;
    }
    editBinding(subject, kind, { entityId: undefined, name: value === 'custom' ? subjectName(reference, subject) : undefined });
  };
  const save = () => {
    if (stale || busy) return;
    for (const [id, subjectBindings] of Object.entries(linkedBindings)) onUpdateReference(id, { subjectBindings });
    onUpdateReference(reference.id, { fullDescription: fullDescription.trim() || undefined, notes: notes.trim() || undefined, subjectBindings: bindings });
    onClose();
  };
  const history = reference.analysisHistory || [];
  return <ReferenceDialog title={'图' + reference.number + ' · 参考资料'} onClose={onClose}>
    <div className="story-reference-dialog-tabs" role="group" aria-label="参考图资料视图">
      {([['details', '完整资料'], ['bindings', '主体与身份'], ['image', '查看图片'], ['history', '识别历史']] as const).map(([value, label]) => <button type="button" className={'btn small ' + (tab === value ? 'primary' : 'ghost')} key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</button>)}
    </div>
    {stale && <p className="story-reference-warning" role="status">识别结果已更新。请关闭并重新打开，再修改最新资料。</p>}
    <div className={'story-reference-dialog-body ' + (tab === 'image' ? 'story-reference-image-body' : '')}>
      {tab === 'image' && (src ? <AssetImagePreview src={src} alt={'图' + reference.number + '参考图片'} /> : <p>图片暂时不可用，请检查资产库中的原图。</p>)}
      {tab === 'details' && <>
        {reference.analysis ? <details open><summary>AI 原始识别 · {localDate(reference.analysis.analyzedAt)}</summary><StoryReferenceAnalysisView analysis={reference.analysis} disabled={busy || stale} onCreatePanelReference={onCreatePanelReference} /></details> : <p className="field-hint">{reference.sourceRole === 'comic' ? '还没有漫画识别资料，请先点击“识别漫画并生成剧情”。' : '还没有识别资料，请先在图片卡片上点击“AI 识图”。'}</p>}
        <label className="story-reference-edit-field"><span>修订完整画面描述</span><textarea value={fullDescription} onChange={(event) => setFullDescription(event.target.value)} disabled={busy || stale} placeholder="可修正完整描述；留空时沿用 AI 原始描述。" /></label>
        <label className="story-reference-edit-field"><span>补充与纠正说明</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} disabled={busy || stale} placeholder="例如：图中人物名为小雨；银色物体是钥匙；本章只参考人物，不采用背景。" /></label>
        <p className="field-hint">保存后，扩写、画面转化和解析都会读取这些修订及完整识别资料。</p>
      </>}
      {tab === 'bindings' && <>
        <p className="field-hint">给主体取剧情名称，或关联项目已有资料。不同图片中的同一主体可选择同一资料，或使用“关联另一张图”。</p>
        {subjectGroups(reference.analysis).flatMap(({ kind, subjects }) => subjects.map((subject) => {
          const binding = bindings.find((item) => item.subjectId === subject.id);
          const value = binding?.entityId ? 'entity:' + binding.entityId : binding?.name ? 'custom' : '';
          return <div className="story-reference-binding" key={kind + subject.id}>
            <strong>{kindLabels[kind]} · {subject.label}</strong><p className="story-reference-prose">{subject.description}</p>
            <label><span>关联资料</span><select aria-label={subject.label + '关联资料'} value={value} disabled={busy || stale} onChange={(event) => chooseBinding(subject, kind, event.target.value)}>
              <option value="">沿用识别名称</option><option value="custom">自定义剧情名称</option>
              <optgroup label={'项目已有' + kindLabels[kind]}>{entityList(project, kind).map((entity) => <option key={entity.id} value={'entity:' + entity.id}>{entity.name}</option>)}</optgroup>
              <optgroup label="关联另一张图">{references.filter((other) => other.id !== reference.id).flatMap((other) => subjectGroups(other.analysis).find((group) => group.kind === kind)!.subjects.map((item) => <option key={other.id + item.id} value={'subject:' + other.id + '|' + item.id}>{referenceLabel(other, item)}</option>))}</optgroup>
            </select></label>
            <label><span>剧情名称</span><input aria-label={subject.label + '剧情名称'} value={binding?.name || ''} placeholder={subject.label} disabled={busy || stale || Boolean(binding?.entityId)} onChange={(event) => editBinding(subject, kind, { name: event.target.value })} /></label>
            {binding?.isNarrator && <span className="story-reference-status">已设为剧情中的“我”</span>}
          </div>;
        }))}
        {!subjectGroups(reference.analysis).some((group) => group.subjects.length) && <p>识图后可在这里关联人物、地点和道具。</p>}
      </>}
      {tab === 'history' && <>
        <p className="field-hint">每次成功识别均单独保存。历史资料供查阅；本章使用当前识别及已保存修订。</p>
        {history.length ? [...history].reverse().map((analysis, index) => <details key={analysis.revision + '-' + index}><summary>{localDate(analysis.analyzedAt)} · 第 {analysis.revision} 次识别</summary><StoryReferenceAnalysisView analysis={analysis} /></details>) : <p>暂无历史识别记录。</p>}
      </>}
    </div>
    <div className="story-reference-dialog-footer"><button type="button" className="btn small ghost" onClick={onClose}>关闭</button><button type="button" className="btn small primary" disabled={busy || stale} onClick={save}>保存资料与绑定</button></div>
  </ReferenceDialog>;
}

function NarratorEditor({ project, references, narrator, disabled, onClose, onBindNarrator }: {
  project: Project; references: StoryReference[]; narrator?: StoryNarrator; onClose: () => void;
  disabled: boolean; onBindNarrator: StoryReferencePanelProps['onBindNarrator'];
}) {
  const currentImage = references.flatMap((reference) => reference.subjectBindings.filter((binding) => binding.isNarrator).map((binding) => 'subject:' + reference.id + '|' + binding.subjectId))[0];
  const [selection, setSelection] = useState(currentImage || (narrator?.entityId ? 'entity:' + narrator.entityId : narrator ? 'custom' : ''));
  const [name, setName] = useState(narrator?.name || '');
  const [description, setDescription] = useState(narrator?.description || '');
  const save = () => {
    if (disabled) return;
    const selectedImage = selection.startsWith('subject:') ? selection.slice(8).split('|') : undefined;
    if (selectedImage) onBindNarrator({ referenceId: selectedImage[0], subjectId: selectedImage[1] });
    else if (selection.startsWith('entity:')) {
      const entityId = selection.slice(7); const entity = project.characters.find((item) => item.id === entityId);
      onBindNarrator({ entityId, name: entity?.name });
    } else onBindNarrator(selection === 'custom' ? { name: name.trim(), description: description.trim() } : undefined);
    onClose();
  };
  return <ReferenceDialog title="剧情中的“我”" onClose={onClose} className="story-reference-narrator-modal">
    <p className="field-hint">写“我和图1中的人物互动”时，可在这里指定“我”是谁；不在参考图中也可以自定义角色。</p>
    <label className="story-reference-edit-field"><span>“我”对应的角色</span><select value={selection} disabled={disabled} onChange={(event) => setSelection(event.target.value)} aria-label="我对应的角色">
      <option value="">由剧情上下文决定</option><option value="custom">自定义一个角色</option>
      <optgroup label="项目人物">{project.characters.filter((item) => !item.dossier?.archivedIntoCharacterId).map((item) => <option key={item.id} value={'entity:' + item.id}>{item.name}</option>)}</optgroup>
      <optgroup label="参考图中的人物">{references.filter((reference) => reference.enabled).flatMap((reference) => (reference.analysis?.characters || []).map((item) => <option key={reference.id + item.id} value={'subject:' + reference.id + '|' + item.id}>{referenceLabel(reference, item)}</option>))}</optgroup>
    </select></label>
    {selection === 'custom' && <><label className="story-reference-edit-field"><span>角色姓名或稳定称呼</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：旅行者小林" /></label><label className="story-reference-edit-field"><span>角色设定</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="填写外貌、身份及与图中人物的关系。" /></label></>}
    <div className="story-reference-dialog-footer"><button type="button" className="btn small ghost" onClick={onClose}>取消</button><button type="button" className="btn small primary" disabled={disabled || selection === 'custom' && !name.trim()} onClick={save}>保存“我”的设定</button></div>
  </ReferenceDialog>;
}

export function StoryReferencePanel({
  project, chapterId, uploading = false, disabled = false, onUpload, onAddAsset, onRecognize,
  onUpdateReference, onRemoveReference, onInsertReference, onBindNarrator,
  onSetImageSourceMode, onSetComicSettings, onMoveComicPage, onGenerateComicStory,
  comicGenerating = false, onUpdateComicStory, onAdoptComicStory, onCreateComicPanelReference,
  onCancelComicGeneration,
}: StoryReferencePanelProps) {
  const workspace = project.chapterWorkspaces?.[chapterId];
  const references = workspace?.storyReferences || [];
  const sourceMode = workspace?.storyImageSourceMode || 'reference';
  const isComicMode = sourceMode === 'comic';
  const comicSettings = storyComicSettings(project, chapterId);
  const comicPages = references.filter((reference) => reference.sourceRole === 'comic').sort((a, b) => (a.pageOrder ?? a.number) - (b.pageOrder ?? b.number) || a.number - b.number);
  const enabledComicPages = comicPages.filter((reference) => reference.enabled);
  const displayReferences = isComicMode ? [...comicPages, ...references.filter((reference) => reference.sourceRole !== 'comic')] : references;
  const draft = workspace?.comicStoryDraft;
  const draftStale = Boolean(draft && draft.sourceFingerprint !== comicSourceFingerprint(project, chapterId));
  const fileRef = useRef<HTMLInputElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editor, setEditor] = useState<{ id: string; tab: 'details' | 'image' }>();
  const [narratorOpen, setNarratorOpen] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [localGenerating, setLocalGenerating] = useState(false);
  const [operationError, setOperationError] = useState('');
  const uploadGuard = useRef(false);
  const generationGuard = useRef(false);
  const ownerRef = useRef(project.id + ':' + chapterId);
  ownerRef.current = project.id + ':' + chapterId;
  const generationBusy = comicGenerating || localGenerating;
  const uploadBusy = uploading || uploadingFiles;
  const busy = disabled || generationBusy || uploadBusy;
  useEffect(() => {
    ownerRef.current = project.id + ':' + chapterId;
    setPickerOpen(false); setEditor(undefined); setNarratorOpen(false); setOperationError('');
    return () => { ownerRef.current = ''; };
  }, [project.id, chapterId]);
  const uploadFiles = async (files: File[]) => {
    if (busy || uploadGuard.current || !files.length) return;
    const selected = isComicMode ? files : files.slice(0, 1);
    if (isComicMode && selected.some((file) => !/\.(png|jpe?g)$/i.test(file.name))) {
      setOperationError('漫画来源目前支持 PNG、JPG 图片。请重新选择。'); return;
    }
    uploadGuard.current = true; setUploadingFiles(true); setOperationError('');
    const role = sourceMode;
    const owner = ownerRef.current;
    try {
      for (const file of selected) {
        if (ownerRef.current !== owner) break;
        await onUpload(file, role);
      }
    }
    catch (error) { if (ownerRef.current === owner) setOperationError(error instanceof Error ? error.message : '图片上传失败，请重试。'); }
    finally { uploadGuard.current = false; setUploadingFiles(false); }
  };
  const generateComicStory = async () => {
    if (busy || generationGuard.current || !enabledComicPages.length) return;
    generationGuard.current = true; setLocalGenerating(true); setOperationError('');
    try { await onGenerateComicStory(); }
    catch (error) { setOperationError(error instanceof Error ? error.message : '漫画剧情生成失败，请重试。'); }
    finally { generationGuard.current = false; setLocalGenerating(false); }
  };
  const editReference = references.find((item) => item.id === editor?.id);
  const imageAssets = project.assets.filter((asset) => asset.type !== 'video' && asset.type !== 'audio' && asset.mediaType !== 'video' && asset.mediaType !== 'audio' && !asset.missing && asset.referenceScope !== 'nsfw-private-profile' && Boolean(assetPreviewUrl(asset)));
  const enabled = references.filter((item) => item.enabled && (isComicMode ? item.sourceRole === 'comic' : item.sourceRole !== 'comic'));
  const ready = enabled.filter((item) => isComicMode ? Boolean(item.analysis?.comic) : Boolean(item.analysis));
  const missingComicPages = enabledComicPages.some((reference) => {
    const asset = project.assets.find((item) => item.id === reference.assetId);
    return !asset || asset.missing || !assetPreviewUrl(asset);
  });
  const imageNarrator = references.flatMap((reference) => (reference.analysis?.characters || []).filter((subject) => reference.subjectBindings.some((binding) => binding.subjectId === subject.id && binding.isNarrator)).map((subject) => referenceLabel(reference, subject)))[0];
  const narratorName = imageNarrator || workspace?.storyNarrator?.name || (workspace?.storyNarrator?.entityId ? project.characters.find((item) => item.id === workspace.storyNarrator?.entityId)?.name : '');
  return <section className="story-reference-panel" aria-label="本章参考图片">
    <div className="story-image-source-mode" role="group" aria-label="图生视频来源">
      <button type="button" className={'btn small ' + (!isComicMode ? 'primary' : 'ghost')} aria-pressed={!isComicMode} disabled={busy} onClick={() => onSetImageSourceMode('reference')}>参考图</button>
      <button type="button" className={'btn small ' + (isComicMode ? 'primary' : 'ghost')} aria-pressed={isComicMode} disabled={busy} onClick={() => onSetImageSourceMode('comic')}>漫画生视频</button>
      {isComicMode && <span className="field-hint">按原漫画故事生成连续动画；原页保留为剧情来源。</span>}
    </div>
    {isComicMode && <div className="story-comic-settings">
      <label><span>阅读方向</span><select aria-label="漫画阅读方向" value={comicSettings.readingDirection} disabled={busy} onChange={(event) => onSetComicSettings({ readingDirection: event.target.value as StoryComicSettings['readingDirection'] })}><option value="rtl">右至左（漫画）</option><option value="ltr">左至右</option><option value="vertical">从上至下（条漫）</option></select></label>
      <label><span>对白语言</span><select aria-label="漫画对白语言" value={comicSettings.dialogueMode} disabled={busy} onChange={(event) => onSetComicSettings({ dialogueMode: event.target.value as StoryComicSettings['dialogueMode'] })}><option value="original">保留原文</option><option value="chinese">中文配音</option></select></label>
      <label><span>成片形式</span><select aria-label="漫画成片形式" value={comicSettings.renderMode} disabled={busy} onChange={(event) => onSetComicSettings({ renderMode: event.target.value as StoryComicSettings['renderMode'] })}><option value="animation">连续动画</option><option value="motion_comic">动效漫画</option></select></label>
      <p className="field-hint">{comicSettings.renderMode === 'animation' ? '连续动画：把原漫画的事件转为连贯动作，避免同一动作在不同镜头重复。' : '动效漫画：保留纸面漫画表现，以推拉镜头和微动作为主。'}{comicSettings.dialogueMode === 'chinese' && ' 中文配音会保留原文对照，后续英文提示词只翻译画面描述。'}</p>
    </div>}
    <div className="story-reference-toolbar"><div className="story-reference-toolbar-buttons">
      <button type="button" className="btn small" disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={14} />{uploadBusy ? '上传中…' : isComicMode ? '上传漫画图片（可多选）' : '上传一张图片'}</button>
      <button type="button" className="btn small ghost" disabled={busy} onClick={() => setPickerOpen(true)}><ImagePlus size={14} />从资产库添加</button>
      <button type="button" className="btn small ghost" disabled={busy} onClick={() => setNarratorOpen(true)} title={narratorName || '指定剧情中的第一人称角色'}><UserRound size={14} />{narratorName ? '我：' + narratorName : '设置“我”'}</button>
    </div><span className="field-hint" role="status">已启用 {enabled.length} {isComicMode ? '页' : '张'} · 已识别 {ready.length} {isComicMode ? '页' : '张'}</span></div>
    <input ref={fileRef} className="story-reference-file-input" type="file" accept={isComicMode ? '.png,.jpg,.jpeg,image/png,image/jpeg' : 'image/*'} multiple={isComicMode} aria-label={isComicMode ? '上传漫画图片，可多选PNG或JPG' : '上传参考图片，一次一张'} onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ''; void uploadFiles(files); }} />
    {references.length ? <div className="story-reference-cards" aria-label="参考图片列表">{displayReferences.map((reference) => {
      const asset = project.assets.find((item) => item.id === reference.assetId);
      const src = asset && assetPreviewUrl(asset);
      const recognizing = reference.status === 'recognizing';
      const isComic = reference.sourceRole === 'comic';
      const pageIndex = comicPages.findIndex((page) => page.id === reference.id);
      const hasAnalysis = isComic ? Boolean(reference.analysis?.comic) : Boolean(reference.analysis);
      const label = '图' + reference.number;
      const status = recognizing ? '识别中…' : reference.status === 'failed' ? hasAnalysis ? '重识别失败，保留原资料' : '识别失败' : hasAnalysis ? isComic ? '已识别 ' + reference.analysis!.comic!.panels.length + ' 格' : '已识别' : isComic ? '待漫画识别' : '待识别';
      return <article className={'story-reference-card ' + (!reference.enabled ? 'is-disabled' : '')} key={reference.id} aria-label={label + '参考图'}>
        <div className="story-reference-card-top"><button type="button" className="story-reference-thumbnail" disabled={!src} onClick={() => setEditor({ id: reference.id, tab: 'image' })} aria-label={'预览' + label}>{src ? <img src={src} alt={label + '：' + (asset?.name || '参考图片')} loading="lazy" /> : <span>图片缺失</span>}</button>
          <div className="story-reference-card-meta"><strong>{isComic ? '第 ' + (pageIndex + 1) + ' 页 · ' + label : label}</strong><span className="story-reference-file-name" title={asset?.name}>{asset?.name || '原图不可用'}</span><span className={'story-reference-status ' + (reference.status === 'failed' ? 'is-error' : '')} role="status">{status}</span><label className="story-reference-enabled"><input type="checkbox" checked={reference.enabled} disabled={busy || recognizing} onChange={(event) => onUpdateReference(reference.id, { enabled: event.target.checked })} />本章启用</label></div>
        </div>
        {reference.error && <div className="story-reference-card-error" title={reference.error}>{reference.error}</div>}
        <div className="story-reference-card-actions">{!isComic && <button type="button" className="btn small" disabled={busy || recognizing || !src || asset?.missing} onClick={() => void onRecognize(reference.id)}><Brain size={13} />{recognizing ? '识别中…' : reference.analysis ? '重新识别' : 'AI 识图'}</button>}<button type="button" className="btn small ghost" onClick={() => setEditor({ id: reference.id, tab: 'details' })}>{isComic ? '查看图格与资料' : '查看与修改'}</button><button type="button" className="btn small ghost" disabled={busy || recognizing} onClick={() => onRemoveReference(reference.id)} title="仅移出本章，图片保留在资产库">移除</button>
          {isComic && <><button type="button" className="btn small ghost" disabled={busy || recognizing || pageIndex === 0} aria-label={label + '漫画页上移'} onClick={() => onMoveComicPage(reference.id, -1)}><ArrowUp size={12} />上移</button><button type="button" className="btn small ghost" disabled={busy || recognizing || pageIndex === comicPages.length - 1} aria-label={label + '漫画页下移'} onClick={() => onMoveComicPage(reference.id, 1)}><ArrowDown size={12} />下移</button></>}
        </div>
        <label className="story-reference-source-role"><span>用途</span><select aria-label={label + '图片用途'} value={isComic ? 'comic' : 'reference'} disabled={busy || recognizing} onChange={(event) => onUpdateReference(reference.id, { sourceRole: event.target.value as 'reference' | 'comic' })}><option value="reference">视频参考图</option><option value="comic">漫画剧情来源</option></select></label>
        <div className="story-reference-subject-chips">{subjectGroups(reference.analysis).flatMap(({ kind, subjects }) => subjects.map((subject) => <button type="button" key={kind + subject.id} className="story-reference-subject-chip" disabled={busy || !reference.enabled} title={'插入' + referenceLabel(reference, subject)} onClick={() => onInsertReference(referenceLabel(reference, subject))}><Link2 size={11} />{subjectName(reference, subject)}</button>))}{!reference.analysis && <span className="field-hint">{isComic ? '从上方统一识别漫画，按页生成连续剧情' : '识别后可点选主体写入剧情'}</span>}</div>
      </article>;
    })}</div> : <div className="story-reference-empty"><Images size={21} /><span>{isComicMode ? '选择 PNG、JPG 漫画页或条漫，可多选上传；随后调整页序和阅读方向。' : '添加参考图后，逐张点击“AI 识图”。每次上传一张，可继续添加多张。'}</span></div>}
    {isComicMode ? <>
      <div className="story-comic-generation"><button type="button" className="btn small primary" disabled={busy || !enabledComicPages.length || missingComicPages} onClick={() => void generateComicStory()}><Brain size={14} />{generationBusy ? '识别漫画并生成剧情中…' : '识别漫画并生成剧情'}</button>{generationBusy && <button type="button" className="btn small ghost" onClick={onCancelComicGeneration}>取消生成</button>}<span className="field-hint">按当前页序联合识别人物、对白与动作，先预览、再采用。</span></div>
      {missingComicPages && <p className="story-reference-warning" role="status">启用的漫画页中有原图缺失，请重新添加或取消启用后再生成。</p>}
      <p className="story-reference-bottom-hint field-hint">页序可调整，永久“图N”编号保持不变。漫画整页用于剧情识别；单格裁图、人物参考或首帧用于视频参考。需要整页故事板时，可把整页另设为视频参考。</p>
      {draft && <section className="story-comic-story-preview" aria-label="漫画剧情预览">
        <div className="story-comic-preview-heading"><strong>连续剧情预览</strong><span className="field-hint">{draft.adoptedAt ? '已采用 · ' + localDate(draft.adoptedAt) : '生成于 ' + localDate(draft.generatedAt)}</span></div>
        {draftStale && <p className="story-reference-warning" role="status">漫画来源、页序、阅读设置或资料已更改。请重新生成剧情后再采用。</p>}
        <textarea aria-label="编辑漫画剧情预览" value={draft.storyText} disabled={busy} onChange={(event) => onUpdateComicStory(event.target.value)} placeholder="这里显示根据漫画生成的连续剧情，可编辑后采用。" />
        <div className="story-comic-preview-actions"><span className="field-hint">采用后写入本章剧情，继续使用现有分镜和视频流程。</span><button type="button" className="btn small primary" disabled={busy || draftStale || !draft.storyText.trim()} onClick={onAdoptComicStory}>采用为本章剧情</button></div>
      </section>}
    </> : <div className="story-reference-bottom-hint field-hint">图片自动进入资产库。剧情可写“让图1和图2的人物互动”；点击主体名称可插入引用。</div>}
    {operationError && <p className="story-reference-warning" role="alert">{operationError}</p>}
    {pickerOpen && createPortal(<ReferenceImagePickerModal open assets={imageAssets} selectedAssetId="" busy={busy} onClose={() => setPickerOpen(false)} onConfirm={(asset) => { setPickerOpen(false); void onAddAsset(asset.id, sourceMode); }} />, document.body)}
    {editReference && editor && <ReferenceEditor key={project.id + ':' + chapterId + ':' + editReference.id} project={project} reference={editReference} references={references} initialTab={editor.tab} disabled={busy} onClose={() => setEditor(undefined)} onUpdateReference={onUpdateReference} onCreatePanelReference={editReference.sourceRole === 'comic' ? (panelId) => onCreateComicPanelReference(editReference.id, panelId) : undefined} />}
    {narratorOpen && <NarratorEditor project={project} references={references} narrator={workspace?.storyNarrator} disabled={busy} onClose={() => setNarratorOpen(false)} onBindNarrator={onBindNarrator} />}
  </section>;
}
