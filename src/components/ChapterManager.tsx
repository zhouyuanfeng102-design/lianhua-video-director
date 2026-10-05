import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArrowDown, ArrowUp, BookOpen, Plus, Scissors, Upload, X } from 'lucide-react';
import { activeChapter, chapterIdForScene, chapterIdForStoryboard, chapterIdForTask, mergeChapterPieces, orderedChapters, splitChapterPiece, splitNovelChapters, type ChapterImportPiece } from '../chapters';
import type { Project } from '../types';
import './ChapterManager.css';

export interface ChapterManagerProps {
  project: Project;
  onSelect: (chapterId: string) => void;
  onCreate: () => void;
  onImport: (pieces: ChapterImportPiece[]) => void;
  onArchive: (chapterId: string, archived: boolean) => void;
  onRename: (chapterId: string, name: string) => void;
  onReorder: (chapterIds: string[]) => void;
}

const PAGE_SIZE = 20;
const normalizeName = (value: string) => value.trim().toLocaleLowerCase('zh-CN');
// Textareas display CRLF as one LF; map the caret back to exact imported bytes'
// decoded UTF-16 positions before splitting the preserved source string.
const originalCaretOffset = (text: string, caret: number): number => {
  let sourceOffset = 0; let displayedOffset = 0;
  while (sourceOffset < text.length && displayedOffset < caret) {
    if (text[sourceOffset] === '\r' && text[sourceOffset + 1] === '\n') sourceOffset++;
    sourceOffset++; displayedOffset++;
  }
  return sourceOffset;
};

export function ChapterManager({ project, onSelect, onCreate, onImport, onArchive, onRename, onReorder }: ChapterManagerProps) {
  const [mode, setMode] = useState<'manage' | 'import' | null>(null);
  const [search, setSearch] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [page, setPage] = useState(0);
  const [pieces, setPieces] = useState<ChapterImportPiece[]>([]);
  const [originalText, setOriginalText] = useState('');
  const [fileName, setFileName] = useState('');
  const [previewIndex, setPreviewIndex] = useState(0);
  const [splitAt, setSplitAt] = useState(0);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const titleId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const projectIdRef = useRef(project.id);
  const readSequenceRef = useRef(0);
  projectIdRef.current = project.id;
  const selected = activeChapter(project);
  const allChapters = useMemo(() => orderedChapters(project, true), [project.sourceDocuments]);
  const visibleChapters = useMemo(() => allChapters.filter((chapter) => !chapter.archived), [allChapters]);
  const filtered = allChapters.filter((chapter) => (includeArchived || !chapter.archived) && normalizeName(chapter.name).includes(normalizeName(search)));
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const chapterPage = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const preview = pieces[previewIndex];
  const previewPage = Math.floor(previewIndex / PAGE_SIZE);
  const previewList = pieces.slice(previewPage * PAGE_SIZE, (previewPage + 1) * PAGE_SIZE);
  const originalPreserved = useMemo(() => pieces.map((piece) => piece.content).join('') === originalText, [pieces, originalText]);
  const duplicateNames = useMemo(() => {
    const seen = new Set(allChapters.map((chapter) => normalizeName(chapter.name)));
    const duplicates = new Set<string>();
    for (const piece of pieces) { const name = normalizeName(piece.name); if (seen.has(name)) duplicates.add(piece.name); seen.add(name); }
    return [...duplicates];
  }, [pieces, allChapters]);
  const counts = useMemo(() => {
    const result = new Map<string, { scenes: number; boards: number; videos: number; running: number }>();
    const count = (id: string | undefined) => { if (!id) return undefined; if (!result.has(id)) result.set(id, { scenes: 0, boards: 0, videos: 0, running: 0 }); return result.get(id)!; };
    for (const scene of project.scenes) { const item = count(chapterIdForScene(project, scene)); if (item && !scene.sourceStale) item.scenes++; }
    for (const board of project.storyboards) { const item = count(chapterIdForStoryboard(project, board)); if (item && !board.sourceStale) item.boards++; }
    for (const task of project.generationTasks) {
      if (task.kind === 'image' || task.kind === 'autofill') continue;
      const item = count(chapterIdForTask(project, task));
      if (item) { if (task.status === 'succeeded') item.videos++; else if (['draft', 'submitting', 'submitted', 'running', 'unknown'].includes(task.status)) item.running++; }
    }
    return result;
  }, [project]);

  useEffect(() => { setMode(null); setPieces([]); setOriginalText(''); setError(''); setReading(false); readSequenceRef.current++; }, [project.id]);
  useEffect(() => () => { readSequenceRef.current++; }, []);
  useEffect(() => {
    if (!mode) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const dialog = dialogRef.current;
    dialog?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMode(null); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])].filter((element) => element.getClientRects().length > 0);
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (!first || !last) { event.preventDefault(); dialog?.focus(); }
      else if (!dialog?.contains(document.activeElement) || document.activeElement === dialog) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => { document.removeEventListener('keydown', onKeyDown, true); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [mode]);

  const loadFile = async (file?: File) => {
    if (!file) return;
    const ownerProjectId = project.id;
    const request = ++readSequenceRef.current;
    setReading(true); setError('');
    try {
      const bytes = await file.arrayBuffer();
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { text = new TextDecoder('gb18030', { fatal: true, ignoreBOM: true }).decode(bytes); }
      if (ownerProjectId !== projectIdRef.current || request !== readSequenceRef.current) return;
      setFileName(file.name); setOriginalText(text); setPieces(splitNovelChapters(text, file.name)); setPreviewIndex(0); setSplitAt(0); setMode('import');
    } catch (reason) { if (request === readSequenceRef.current) setError(reason instanceof Error ? reason.message : '无法读取文件，请使用 TXT 或 MD 文本。'); }
    finally { if (request === readSequenceRef.current) setReading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const moveChapter = (id: string, delta: number) => {
    const ids = allChapters.map((chapter) => chapter.id);
    const index = ids.indexOf(id); const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    onReorder(ids);
  };

  const choosePreview = (index: number) => { setPreviewIndex(index); setSplitAt(0); };
  const splitPreview = () => {
    if (!preview) return;
    const split = splitChapterPiece(preview, splitAt);
    if (split.length !== 2) return;
    setPieces((current) => [...current.slice(0, previewIndex), ...split, ...current.slice(previewIndex + 1)]); setSplitAt(0);
  };
  const confirmImport = () => {
    if (!pieces.length || !originalPreserved || pieces.some((piece) => !piece.name.trim())) return;
    onImport(pieces); setMode(null); setPieces([]); setOriginalText('');
  };

  return <>
    <div className="chapter-toolbar" aria-label="章节选择与管理">
      <label><BookOpen size={17} /><span>当前章节</span><select aria-label="当前章节" value={selected?.id ?? ''} onChange={(event) => onSelect(event.target.value)}>{visibleChapters.length ? visibleChapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.name}</option>) : <option value="">尚未新建章节</option>}</select></label>
      <div className="chapter-toolbar-actions"><button type="button" className="btn small" onClick={() => { setMode('manage'); setSearch(''); setPage(0); }}>章节管理</button><button type="button" className="btn small" onClick={onCreate}><Plus size={15} />新建章节</button><button type="button" className="btn small" disabled={reading} onClick={() => fileRef.current?.click()}><Upload size={15} />{reading ? '读取中…' : '导入小说'}</button></div>
      <input ref={fileRef} hidden type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={(event) => { void loadFile(event.target.files?.[0]); }} />
    </div>
    {error && <p className="chapter-notice" role="alert">{error}</p>}
    {mode && createPortal(<div className="chapter-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setMode(null); }}><div ref={dialogRef} className={`chapter-dialog ${mode === 'import' ? 'chapter-import-dialog' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className="chapter-dialog-header"><div><h2 id={titleId}>{mode === 'import' ? '导入小说 · 分章预览' : '章节管理'}</h2><p>{mode === 'import' ? `${fileName} · ${originalText.length.toLocaleString()} 字符 · ${pieces.length} 个章节` : '同一项目共用人物、地点、道具和素材；各章分别规划和生成。'}</p></div><button type="button" className="btn small" onClick={() => setMode(null)}><X size={16} />关闭</button></header>
      {mode === 'manage' ? <>
        <div className="chapter-search"><input aria-label="搜索章节" placeholder="搜索章节名称" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} /><label><input type="checkbox" checked={includeArchived} onChange={(event) => { setIncludeArchived(event.target.checked); setPage(0); }} />显示归档章节</label><button type="button" className="btn small" onClick={() => { onCreate(); setMode(null); }}><Plus size={15} />新建章节</button></div>
        <div className="chapter-management-list">{chapterPage.map((chapter) => {
          const index = allChapters.findIndex((item) => item.id === chapter.id); const stats = counts.get(chapter.id);
          return <article className={`chapter-management-row ${chapter.id === selected?.id ? 'selected' : ''}`} key={chapter.id}>
            <div className="chapter-row-main"><input aria-label={`章节名称：${chapter.name}`} key={`${chapter.id}-${chapter.name}`} defaultValue={chapter.name} onBlur={(event) => { const name = event.target.value.trim(); if (name && name !== chapter.name) onRename(chapter.id, name); else event.target.value = chapter.name; }} /><p>{chapter.id === selected?.id && <strong>当前章节 · </strong>}{chapter.archived && '已归档 · '}{chapter.historical && '历史内容待归属 · '}{chapter.content.length.toLocaleString()} 字符 · 已解析 {stats?.scenes ?? 0} 场景 · {stats?.boards ?? 0} 组分镜 · 视频成功 {stats?.videos ?? 0}{stats?.running ? ` · 处理中 ${stats.running}` : ''}</p></div>
            <div className="chapter-row-actions"><button type="button" className="btn small" disabled={chapter.archived || chapter.id === selected?.id} onClick={() => { onSelect(chapter.id); setMode(null); }}>打开</button><button type="button" className="btn small" aria-label={`上移章节 ${chapter.name}`} disabled={index === 0} onClick={() => moveChapter(chapter.id, -1)}><ArrowUp size={15} /></button><button type="button" className="btn small" aria-label={`下移章节 ${chapter.name}`} disabled={index === allChapters.length - 1} onClick={() => moveChapter(chapter.id, 1)}><ArrowDown size={15} /></button><button type="button" className="btn small" disabled={!chapter.archived && visibleChapters.length <= 1} onClick={() => onArchive(chapter.id, !chapter.archived)}><Archive size={15} />{chapter.archived ? '恢复' : '归档'}</button></div>
          </article>;
        })}{!chapterPage.length && <p className="chapter-empty">没有符合条件的章节。</p>}</div>
        <footer className="chapter-dialog-footer"><span>归档保留历史结果和任务；正在生成的视频继续运行。</span><div className="chapter-pagination"><button type="button" className="btn small" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage + 1} / {totalPages}</span><button type="button" className="btn small" disabled={currentPage + 1 >= totalPages} onClick={() => setPage(currentPage + 1)}>下一页</button></div></footer>
      </> : <>
        <p className="chapter-import-hint">自动识别章节标题。可修改章节名称；在正文中点击分割位置后拆分，或合并相邻章节。导入只保存原文。</p>
        {duplicateNames.length > 0 && <p className="chapter-notice">发现重名章节：{duplicateNames.slice(0, 4).join('、')}{duplicateNames.length > 4 ? '等' : ''}。本次会追加为新章节，已有章节保持原样。</p>}
        <div className="chapter-import-content"><aside className="chapter-preview-list">{previewList.map((piece, offset) => {
          const index = previewPage * PAGE_SIZE + offset;
          return <button key={index} type="button" className={index === previewIndex ? 'selected' : ''} onClick={() => choosePreview(index)}><strong>{index + 1}. {piece.name}</strong><small>{piece.content.length.toLocaleString()} 字符{piece.volume ? ` · ${piece.volume}` : ''}</small></button>;
        })}<div className="chapter-pagination"><button type="button" className="btn small" disabled={previewPage === 0} onClick={() => choosePreview((previewPage - 1) * PAGE_SIZE)}>上一页</button><span>{previewPage + 1} / {Math.max(1, Math.ceil(pieces.length / PAGE_SIZE))}</span><button type="button" className="btn small" disabled={(previewPage + 1) * PAGE_SIZE >= pieces.length} onClick={() => choosePreview((previewPage + 1) * PAGE_SIZE)}>下一页</button></div></aside>
          <section className="chapter-preview-editor">{preview && <><label>章节名称<input aria-label="导入章节名称" value={preview.name} onChange={(event) => { const name = event.target.value; setPieces((current) => current.map((piece, index) => index === previewIndex ? { ...piece, name } : piece)); }} /></label><textarea ref={textRef} aria-label="章节原文预览，点击选择分割位置" readOnly value={preview.content} onSelect={(event) => setSplitAt(originalCaretOffset(preview.content, event.currentTarget.selectionStart))} /><div className="chapter-preview-tools"><button type="button" className="btn small" disabled={splitAt <= 0 || splitAt >= preview.content.length} onClick={splitPreview}><Scissors size={15} />从选中位置拆分</button><button type="button" className="btn small" disabled={previewIndex + 1 >= pieces.length} onClick={() => { setPieces((current) => mergeChapterPieces(current, previewIndex)); setSplitAt(0); }}>合并下一章</button><span>{splitAt > 0 ? `当前位置：${splitAt.toLocaleString()}` : '点击正文选择分割位置'}</span></div></>}</section></div>
        <footer className="chapter-dialog-footer"><span className={!originalPreserved ? 'chapter-notice' : ''}>{originalPreserved ? '原文完整保留；导入后选择章节再解析。' : '分章内容与原文不一致，请重新导入。'}</span><button type="button" className="btn primary" disabled={!pieces.length || !originalPreserved || pieces.some((piece) => !piece.name.trim())} onClick={confirmImport}>追加导入 {pieces.length} 个章节</button></footer>
      </>}
    </div></div>, document.body)}
  </>;
}
