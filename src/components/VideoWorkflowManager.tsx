import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { importComfyVideoWorkflow, parseComfyVideoWorkflow, type ComfyVideoNodeMap } from '../comfyuiVideo';
import type { ComfyVideoConfig, ComfyVideoInputBinding, ComfyVideoMapping, ComfyVideoWorkflowPreset } from '../videoGenerationTypes';
import {
  activateVideoWorkflowPreset, assertSafeVideoWorkflowJson, copyVideoWorkflowPreset, createVideoWorkflowDraft,
  deleteVideoWorkflowPreset, exportVideoWorkflowJson, formatVideoWorkflowJson, importVideoWorkflowPreset, isVideoWorkflowConnection,
  inspectVideoWorkflowWarnings, isVideoWorkflowReady, readVideoWorkflowInput, saveVideoWorkflowPreset, updateVideoWorkflowInput,
  validateVideoWorkflowPreset, videoWorkflowDeletionFallback,
} from '../videoWorkflowLibrary';
import '../videoWorkflowManager.css';

export interface VideoWorkflowManagerProps {
  config: ComfyVideoConfig;
  getCurrentConfig?: () => ComfyVideoConfig;
  onChange: (next: ComfyVideoConfig) => void;
  onClose: () => void;
  initialWorkflowId?: string;
}

type EditorTab = 'basic' | 'mapping' | 'parameters' | 'json';
type MappingTab = 'prompt' | 'images' | 'output';
interface Confirmation { title: string; body: string; actionLabel: string; danger?: boolean; action: () => void }
const tabs: Array<[EditorTab, string]> = [['basic', '基本信息'], ['mapping', '节点映射'], ['parameters', '参数设置'], ['json', 'API JSON']];
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请检查工作流设置。';
const jsonKey = (value: unknown) => JSON.stringify(value);
const scalarText = (value: unknown) => typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
// Keep complete cards visible at the desktop minimum size with enlarged fonts.
// A fixed page size avoids resize/measurement feedback while editing fields.
const editorPageSize = 2;
const currentUiFontScale = () => {
  if (typeof document === 'undefined') return '1';
  const shell = document.querySelector('.app-shell') || document.documentElement;
  const scale = getComputedStyle(shell).getPropertyValue('--ui-font-scale').trim();
  return Number.isFinite(Number(scale)) && Number(scale) > 0 ? scale : '1';
};

function Pager({ label, total, page, size, onChange }: { label: string; total: number; page: number; size: number; onChange: (page: number) => void }) {
  const count = Math.max(1, Math.ceil(total / size));
  const current = Math.min(page, count - 1);
  return <div className="vwm-pager" aria-label={`${label}分页`}><span>{total} 项</span><div><button type="button" className="btn small" aria-label={`${label}上一页`} disabled={current === 0} onClick={() => onChange(current - 1)}>‹</button><span>{current + 1} / {count}</span><button type="button" className="btn small" aria-label={`${label}下一页`} disabled={current + 1 >= count} onClick={() => onChange(current + 1)}>›</button></div></div>;
}

function BindingFields({ binding, nodes, label, onChange }: { binding: ComfyVideoInputBinding; nodes: ComfyVideoNodeMap; label: string; onChange: (next: ComfyVideoInputBinding) => void }) {
  const listId = `vwm-${encodeURIComponent(label)}`;
  const node = Object.prototype.hasOwnProperty.call(nodes, binding.nodeId) ? nodes[binding.nodeId] : undefined;
  const fields = Object.entries(node?.inputs || {});
  return <div className="vwm-binding-fields">
    <label className="field"><span>节点 ID</span><input aria-label={`${label}节点 ID`} list={`${listId}-nodes`} value={binding.nodeId} placeholder="节点 ID" onChange={(event) => onChange({ ...binding, nodeId: event.target.value })} /><datalist id={`${listId}-nodes`}>{Object.entries(nodes).map(([id, value]) => <option key={id} value={id}>{value._meta?.title || value.class_type}</option>)}</datalist></label>
    <label className="field"><span>实际输入字段</span><input aria-label={`${label}输入字段`} list={`${listId}-fields`} value={binding.inputName} placeholder="如 value、text、image" onChange={(event) => onChange({ ...binding, inputName: event.target.value })} /><datalist id={`${listId}-fields`}>{fields.map(([name, value]) => <option key={name} value={name}>{isVideoWorkflowConnection(value) ? '节点连线（不可覆盖）' : typeof value}</option>)}</datalist></label>
  </div>;
}

/** A library editor: selecting a row is deliberately different from activating it. */
export function VideoWorkflowManager({ config, getCurrentConfig, onChange, onClose, initialWorkflowId }: VideoWorkflowManagerProps) {
  const initial = config.workflows.find((item) => item.id === initialWorkflowId)
    || config.workflows.find((item) => item.id === config.activeWorkflowId) || config.workflows[0];
  const [draft, setDraft] = useState<ComfyVideoWorkflowPreset | undefined>(() => initial ? structuredClone(initial) : undefined);
  const [baseline, setBaseline] = useState(() => initial ? jsonKey(initial) : '');
  const [tab, setTab] = useState<EditorTab>('basic');
  const [mappingTab, setMappingTab] = useState<MappingTab>('prompt');
  const [libraryPage, setLibraryPage] = useState(0);
  const [mappingPage, setMappingPage] = useState(0);
  const [parameterPage, setParameterPage] = useState(0);
  const [search, setSearch] = useState('');
  const [parameterName, setParameterName] = useState('');
  const [parameterEdits, setParameterEdits] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [importing, setImporting] = useState(false);
  // The modal portal lives outside .app-shell; explicitly inherit its font setting.
  const [uiFontScale, setUiFontScale] = useState(currentUiFontScale);
  const dialogRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const baseStoredRef = useRef(initial ? jsonKey(initial) : '');
  const mountedRef = useRef(true);
  const dirty = Boolean(draft && (jsonKey(draft) !== baseline || Object.keys(parameterEdits).length));
  const latestRef = useRef({ config, getCurrentConfig, onChange, onClose, dirty, confirmation, close: () => {} });
  latestRef.current = { config, getCurrentConfig, onChange, onClose, dirty, confirmation, close: () => requestClose() };
  const currentConfig = () => latestRef.current.getCurrentConfig?.() || latestRef.current.config;
  const parsed = useMemo(() => {
    if (!draft) return { nodes: {} as ComfyVideoNodeMap, issues: [] as string[], warnings: [] as string[] };
    const issues = validateVideoWorkflowPreset(draft);
    try { return { nodes: parseComfyVideoWorkflow(draft.workflowJson), issues, warnings: inspectVideoWorkflowWarnings(draft) }; }
    catch { return { nodes: {} as ComfyVideoNodeMap, issues, warnings: [] as string[] }; }
  }, [draft]);
  const current = config.workflows.find((item) => item.id === config.activeWorkflowId);
  const savedDraft = config.workflows.find((item) => item.id === draft?.id);
  const filtered = config.workflows.filter((item) => !search.trim() || `${item.name} ${item.id}`.toLowerCase().includes(search.trim().toLowerCase()));
  const listPage = Math.min(libraryPage, Math.max(0, Math.ceil(filtered.length / 5) - 1));
  const parameterEntries = Object.entries(draft?.mapping.parameters || {});
  const activeParameterPage = Math.min(parameterPage, Math.max(0, Math.ceil(parameterEntries.length / editorPageSize) - 1));

  useEffect(() => {
    mountedRef.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialogRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    const onKey = (event: KeyboardEvent) => {
      const scope = dialogRef.current?.querySelector<HTMLElement>('[role="alertdialog"]') || dialogRef.current;
      if (!scope) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (latestRef.current.confirmation) setConfirmation(undefined); else latestRef.current.close();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = [...scope.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter((item) => item.getClientRects().length && !item.closest('[hidden]'));
      const first = elements[0]; const last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || !scope.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !scope.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { mountedRef.current = false; document.removeEventListener('keydown', onKey, true); if (previous?.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    const shell = document.querySelector('.app-shell') || document.documentElement;
    const observer = new MutationObserver(() => setUiFontScale(currentUiFontScale()));
    observer.observe(shell, { attributes: true, attributeFilter: ['style', 'class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!confirmation) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialogRef.current?.querySelector<HTMLElement>('[role="alertdialog"] button')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [confirmation]);

  function clearNotice() { setError(''); setMessage(''); }
  function loadDraft(workflow: ComfyVideoWorkflowPreset | undefined, saved = true) {
    const copy = workflow ? structuredClone(workflow) : undefined;
    setDraft(copy); setBaseline(saved && copy ? jsonKey(copy) : '');
    baseStoredRef.current = saved && copy ? jsonKey(copy) : '';
    setParameterEdits({}); setParameterName(''); setMappingPage(0); setParameterPage(0); clearNotice();
  }
  function guardDiscard(action: () => void, description = '切换后会放弃当前工作流尚未保存的编辑，已保存版本保持不变。') {
    if (!latestRef.current.dirty) { action(); return; }
    setConfirmation({ title: '有未保存的工作流编辑', body: description, actionLabel: '放弃编辑并继续', danger: true, action });
  }
  function requestClose() { guardDiscard(() => latestRef.current.onClose(), '关闭后会放弃当前尚未保存的工作流编辑。已经点“保存工作流”的内容会保留。'); }
  function applyConfig(next: ComfyVideoConfig) {
    // Keep rapid consecutive library operations from starting with an older render.
    latestRef.current.onChange(next);
    latestRef.current.config = next;
  }
  function patchDraft(patch: Partial<ComfyVideoWorkflowPreset>) { setDraft((value) => value ? { ...value, ...patch } : value); clearNotice(); }
  function patchMapping(patch: Partial<ComfyVideoMapping>) { if (draft) patchDraft({ mapping: { ...draft.mapping, ...patch } }); }
  function materializeDraft(): ComfyVideoWorkflowPreset {
    if (!draft) throw new Error('请选择或新建工作流。');
    let workflowJson = draft.workflowJson;
    for (const [name, value] of Object.entries(parameterEdits)) {
      const binding = draft.mapping.parameters?.[name];
      if (!binding) throw new Error(`参数 ${name} 的映射已变化，请重新选择输入字段。`);
      try { workflowJson = updateVideoWorkflowInput(workflowJson, binding, value); }
      catch (cause) { throw new Error(`参数 ${name}：${errorText(cause)}`); }
    }
    return { ...draft, workflowJson };
  }
  function switchTab(next: EditorTab) {
    try {
      if (Object.keys(parameterEdits).length) { setDraft(materializeDraft()); setParameterEdits({}); }
      setTab(next); setError('');
    } catch (cause) { setError(errorText(cause)); }
  }
  function save() {
    clearNotice();
    try {
      const nextDraft = materializeDraft();
      const latest = currentConfig();
      const persisted = latest.workflows.find((item) => item.id === nextDraft.id);
      if (baseStoredRef.current && (!persisted || jsonKey(persisted) !== baseStoredRef.current)) throw new Error('此工作流已在其他位置变化。请关闭后重新打开，避免覆盖新的设置。');
      const next = saveVideoWorkflowPreset(latest, nextDraft);
      applyConfig(next);
      loadDraft(next.workflows.find((item) => item.id === nextDraft.id));
      setMessage(isVideoWorkflowReady(nextDraft) ? '已保存工作流设置；已提交任务仍使用原来的快照。' : '已保存为待配置草稿；补全节点与映射后才能设为当前。');
    } catch (cause) { setError(errorText(cause)); }
  }
  function activate() {
    clearNotice();
    if (!draft) return;
    if (dirty) { setError('请先保存当前编辑，再设为当前工作流。'); return; }
    try { applyConfig(activateVideoWorkflowPreset(currentConfig(), draft.id)); setMessage(`已选择“${draft.name}”作为当前视频工作流；不会自动开启视频接口。`); }
    catch (cause) { setError(errorText(cause)); }
  }
  function create() { guardDiscard(() => { loadDraft(createVideoWorkflowDraft(currentConfig().workflows), false); setTab('basic'); }); }
  function copy() {
    clearNotice();
    try { const next = copyVideoWorkflowPreset(materializeDraft(), currentConfig().workflows); loadDraft(next, false); setTab('basic'); setMessage('已复制为独立编辑稿；保存后加入列表，原工作流保持不变。'); }
    catch (cause) { setError(errorText(cause)); }
  }
  function remove() {
    if (!draft || !savedDraft) return;
    const id = draft.id;
    const latest = currentConfig();
    const fallback = videoWorkflowDeletionFallback(latest, id);
    const activeNote = latest.activeWorkflowId === id ? fallback ? `删除后当前工作流切换为“${fallback.name}”。` : '其余工作流尚未配置完成，删除后会关闭 ComfyUI 视频开关；请配置后重新启用。' : '当前使用的工作流不变。';
    setConfirmation({ title: `删除“${savedDraft.name}”？`, body: `${activeNote} 仅删除这份设置，不删除 ComfyUI 文件、素材或历史任务。${dirty ? '未保存的编辑也会放弃。' : ''}`, actionLabel: '确认删除工作流', danger: true, action: () => {
      const latestAtConfirm = currentConfig();
      const persisted = latestAtConfirm.workflows.find((item) => item.id === id);
      if (!persisted || (baseStoredRef.current && jsonKey(persisted) !== baseStoredRef.current)
        || latestAtConfirm.activeWorkflowId !== latest.activeWorkflowId
        || videoWorkflowDeletionFallback(latestAtConfirm, id)?.id !== fallback?.id) {
        setError('工作流或当前选择已在其他位置变化，请重新打开后确认删除；未删除任何设置。'); return;
      }
      const next = deleteVideoWorkflowPreset(latestAtConfirm, id);
      applyConfig(next); loadDraft(next.workflows.find((item) => item.id === next.activeWorkflowId) || next.workflows[0]);
      setMessage('已删除所选工作流设置，历史任务与素材未改动。');
    } });
  }
  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setImporting(true); clearNotice();
    try {
      if (file.size > 16 * 1024 * 1024) throw new Error('工作流 JSON 超过 16 MB，请确认导入的是 API 格式工作流，而不是包含素材的项目文件。');
      const text = await file.text();
      if (!mountedRef.current) return;
      // Validate before asking to discard another draft.
      assertSafeVideoWorkflowJson(text);
      guardDiscard(() => {
        try {
          const latest = currentConfig();
          const imported = importVideoWorkflowPreset(text, file.name, latest.workflows);
          applyConfig({ ...latest, workflows: [...latest.workflows, imported] });
          loadDraft(imported); setSearch(''); setLibraryPage(Math.floor(latest.workflows.length / 5)); setTab('basic');
          setMessage('已新增导入工作流，未覆盖已有内容；核对映射后可设为当前。');
        } catch (cause) { setError(errorText(cause)); }
      });
    } catch (cause) { if (mountedRef.current) setError(errorText(cause)); }
    finally { if (mountedRef.current) setImporting(false); }
  }
  function exportJson() {
    clearNotice();
    try {
      if (!draft || dirty) throw new Error('请先保存工作流，再导出已保存的 API JSON。');
      const text = exportVideoWorkflowJson(draft);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `${draft.name.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').slice(0, 100) || 'video-workflow'}.api.json`;
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage('已导出 API 节点 JSON；不包含连接地址或认证密钥。自定义映射保留在软件工作流设置中。');
    } catch (cause) { setError(errorText(cause)); }
  }
  function recognize() {
    if (!draft) return;
    try { assertSafeVideoWorkflowJson(draft.workflowJson); }
    catch (cause) { setError(errorText(cause)); return; }
    setConfirmation({ title: '重新识别节点映射？', body: '只重新识别提示词、图片、输出与常见参数映射，不改工作流原始参数。现有自定义映射和图片槽顺序将被替换；每段视频用途在生成视频时单独设置。确认后仍需保存。', actionLabel: '确认重新识别', action: () => {
      try { const imported = importComfyVideoWorkflow(draft.workflowJson); patchDraft({ mapping: imported.mapping }); setParameterEdits({}); setMessage('已重新识别到编辑稿，请检查映射并保存；工作流原始值未改变。'); }
      catch (cause) { setError(errorText(cause)); }
    } });
  }
  function parameterBinding(name: string, binding: ComfyVideoInputBinding) {
    const next = { ...parameterEdits }; delete next[name]; setParameterEdits(next);
    patchMapping({ parameters: { ...draft?.mapping.parameters, [name]: binding } });
  }
  function addParameter() {
    const name = parameterName.trim();
    if (!name || !draft) return;
    if (['__proto__', 'prototype', 'constructor'].includes(name)) { setError('此名称不能作为参数名，请使用 seed、steps 等普通名称。'); return; }
    if (Object.prototype.hasOwnProperty.call(draft.mapping.parameters || {}, name)) { setError('已存在同名参数，请编辑原映射，或使用不同名称。'); return; }
    patchMapping({ parameters: { ...draft.mapping.parameters, [name]: { nodeId: '', inputName: name } } });
    setParameterName(''); setParameterPage(Math.floor(parameterEntries.length / editorPageSize));
  }
  function moveImage(index: number, delta: number) {
    if (!draft) return;
    const images = [...draft.mapping.images]; const next = index + delta;
    if (next < 0 || next >= images.length) return;
    [images[index], images[next]] = [images[next], images[index]];
    patchMapping({ images }); setMappingPage(Math.floor(next / editorPageSize));
  }

  const mappingRows = draft && mappingTab !== 'output' ? draft.mapping[mappingTab] : [];
  const activeMappingPage = Math.min(mappingPage, Math.max(0, Math.ceil(mappingRows.length / editorPageSize) - 1));
  const modal = <div className="vwm-backdrop" style={{ '--ui-font-scale': uiFontScale } as CSSProperties} onMouseDown={(event) => { if (event.target === event.currentTarget && !confirmation) requestClose(); }}>
    <section className="vwm-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label="ComfyUI 视频工作流管理">
      <header className="vwm-header"><div><h2>视频工作流管理</h2><p>每份工作流独立保存，编辑列表不会自动切换当前工作流。</p></div><button type="button" className="btn small" onClick={requestClose}>关闭</button></header>
      <div className="vwm-body">
        <aside className="vwm-library" aria-label="已保存的视频工作流">
          <div className="vwm-library-heading"><strong>工作流库</strong><span>{config.workflows.length} 份</span></div>
          <div className="vwm-library-tools"><button type="button" className="btn small" onClick={create}>新建草稿</button><button type="button" className="btn small" disabled={importing} onClick={() => fileRef.current?.click()}>{importing ? '读取中…' : '导入 API JSON'}</button></div>
          <input aria-label="搜索视频工作流" value={search} placeholder="搜索工作流名称" onChange={(event) => { setSearch(event.target.value); setLibraryPage(0); }} />
          <div className="vwm-library-list">{filtered.slice(listPage * 5, (listPage + 1) * 5).map((workflow) => <button type="button" className={`vwm-library-item${draft?.id === workflow.id ? ' selected' : ''}`} key={workflow.id} aria-pressed={draft?.id === workflow.id} onClick={() => { if (draft?.id !== workflow.id) guardDiscard(() => loadDraft(workflow)); }}><strong title={workflow.name}>{workflow.name}</strong><span>{config.activeWorkflowId === workflow.id ? '● 当前使用' : isVideoWorkflowReady(workflow) ? '已配置' : '待配置'}{draft?.id === workflow.id && dirty ? ' · 未保存' : ''}</span></button>)}{!filtered.length && <p className="vwm-empty">{search ? '没有匹配的工作流。' : '导入 API JSON，或先新建草稿。'}</p>}</div>
          <Pager label="工作流库" total={filtered.length} page={listPage} size={5} onChange={setLibraryPage} />
          <div className="vwm-current"><span>当前使用</span><strong title={current?.name}>{current?.name || '尚未选择'}</strong><small>选中编辑 ≠ 设为当前</small></div>
        </aside>
        <main className="vwm-editor">{draft ? <>
          <div className="vwm-editor-heading"><div><strong title={draft.name}>{draft.name || '未命名工作流'}</strong><span className={`vwm-state${dirty ? ' pending' : ''}`}>{dirty ? '未保存' : parsed.issues.length ? '待配置草稿' : '已保存'}</span></div><div className="vwm-editor-actions"><button type="button" className="btn small" onClick={copy}>复制</button><button type="button" className="btn small" onClick={() => { switchTab('basic'); requestAnimationFrame(() => { nameRef.current?.focus(); nameRef.current?.select(); }); }}>重命名</button><button type="button" className="btn small danger" disabled={!savedDraft} onClick={remove}>删除</button></div></div>
          <nav className="vwm-tabs" role="tablist" aria-label="视频工作流编辑分页">{tabs.map(([key, label]) => <button type="button" role="tab" aria-selected={tab === key} aria-controls={`vwm-panel-${key}`} id={`vwm-tab-${key}`} className={tab === key ? 'active' : ''} key={key} onClick={() => switchTab(key)}>{label}{key === 'parameters' && parameterEntries.length ? ` ${parameterEntries.length}` : ''}</button>)}</nav>
          <div className={`vwm-tab-panel vwm-tab-${tab}`} id={`vwm-panel-${tab}`} role="tabpanel" aria-labelledby={`vwm-tab-${tab}`}>
            {tab === 'basic' && <>
              <label className="field"><span>工作流名称</span><input ref={nameRef} aria-label="视频工作流名称" value={draft.name} placeholder="如 Wan 2.2 首尾帧 / H3 多参考视频" onChange={(event) => patchDraft({ name: event.target.value })} /></label>
              <div className="vwm-summary-grid"><div><span>API 节点</span><strong>{Object.keys(parsed.nodes).length}</strong></div><div><span>提示词输入</span><strong>{draft.mapping.prompt.length}</strong></div><div><span>图片槽位</span><strong>{draft.mapping.images.length}</strong></div><div><span>最终输出</span><strong>{draft.mapping.outputNodeId || '自动识别结果'}</strong></div></div>
              <div className="vwm-info"><strong>{parsed.issues.length ? '仍需配置' : '可以设为当前工作流'}</strong>{parsed.issues.length ? <ul>{parsed.issues.slice(0, 4).map((item, index) => <li key={index}>{item}</li>)}{parsed.issues.length > 4 && <li>另有 {parsed.issues.length - 4} 项，请在映射和参数页检查。</li>}</ul> : <p>必需输入已核对。这里不会测试远端连接或发起生成。</p>}</div>
              {!parsed.issues.length && Boolean(parsed.warnings.length) && <div className="vwm-info"><strong>可选项提示（不影响保存）</strong><ul>{parsed.warnings.slice(0, 3).map((item, index) => <li key={index}>{item}</li>)}</ul><p>实际选用图片或覆盖参数时，生成流程会检查对应映射。</p></div>}
              <p className="vwm-help">参数设置编辑工作流内的原始值；导演台显式填写的同名参数只覆盖那次任务。未映射的节点、音频连线、采样配置等原值保留。</p>
              <p className="vwm-help">新建草稿允许暂存空工作流；只有有效工作流才能设为当前。连接地址与密钥仍在外面的连接设置中管理。</p>
            </>}
            {tab === 'mapping' && <><div className="vwm-section-tabs" role="tablist" aria-label="节点映射类型">{(['prompt', 'images', 'output'] as const).map((key) => <button type="button" className={mappingTab === key ? 'active' : ''} role="tab" aria-selected={mappingTab === key} key={key} onClick={() => { setMappingTab(key); setMappingPage(0); }}>{key === 'prompt' ? `提示词 ${draft.mapping.prompt.length}` : key === 'images' ? `图片槽 ${draft.mapping.images.length}` : '视频输出'}</button>)}</div>
              {mappingTab === 'output' ? <div className="vwm-output-mapping"><label className="field"><span>最终视频输出节点 ID</span><input aria-label="最终视频输出节点 ID" list="vwm-output-nodes" placeholder="留空则收集可用视频输出" value={draft.mapping.outputNodeId || ''} onChange={(event) => patchMapping({ outputNodeId: event.target.value || undefined })} /><datalist id="vwm-output-nodes">{Object.entries(parsed.nodes).map(([id, node]) => <option key={id} value={id}>{node._meta?.title || node.class_type}</option>)}</datalist></label><div className="vwm-info"><strong>指定真正输出成片的节点</strong><p>通常选择 SaveVideo 或带音轨的 VideoCombine。也支持自定义输出节点，不会按名称强制改写。</p><p>留空时沿用自动收集视频结果；存在多个预览与最终成片时，建议明确指定最终输出节点。</p></div></div> : <><div className="vwm-mapping-list">{mappingRows.slice(activeMappingPage * editorPageSize, (activeMappingPage + 1) * editorPageSize).map((binding, localIndex) => {
                const index = activeMappingPage * editorPageSize + localIndex;
                const label = mappingTab === 'prompt' ? `提示词 ${index + 1} ` : `图片槽 ${index + 1} `;
                return <div className="vwm-mapping-item" key={`${mappingTab}-${index}`}><div className="vwm-row"><strong>{label}</strong><div>{mappingTab === 'images' && <><button type="button" className="btn small" aria-label={`上移图片槽 ${index + 1}`} disabled={index === 0} onClick={() => moveImage(index, -1)}>↑</button><button type="button" className="btn small" aria-label={`下移图片槽 ${index + 1}`} disabled={index === draft.mapping.images.length - 1} onClick={() => moveImage(index, 1)}>↓</button></>}<button type="button" className="btn small" aria-label={`移除${label.trim()}`} onClick={() => patchMapping({ [mappingTab]: mappingRows.filter((_, position) => position !== index) })}>移除</button></div></div><div className={mappingTab === 'images' ? 'vwm-image-fields' : ''}><BindingFields nodes={parsed.nodes} label={label} binding={binding} onChange={(next) => patchMapping({ [mappingTab]: mappingRows.map((item, position) => position === index ? { ...item, ...next } : item) })} />{mappingTab === 'images' && <p className="field-hint">每段视频的图片用途在“生成视频 → 选择参考图”中设置；这里仅保留槽位顺序与实际输入字段。</p>}</div></div>;
              })}{!mappingRows.length && <div className="vwm-empty">{mappingTab === 'prompt' ? '添加实际提示词字段，例如文字节点的 value 或 text。' : '文生视频无需图片槽。图生视频请添加真实的图片输入字段。'}</div>}</div><div className="vwm-collection-footer"><button type="button" className="btn small" onClick={() => { if (mappingTab === 'prompt') patchMapping({ prompt: [...draft.mapping.prompt, { nodeId: '', inputName: 'value' }] }); else patchMapping({ images: [...draft.mapping.images, { nodeId: '', inputName: 'image', role: 'general' }] }); setMappingPage(Math.floor(mappingRows.length / editorPageSize)); }}>{mappingTab === 'prompt' ? '添加提示词输入' : '添加图片槽'}</button><Pager label={mappingTab === 'prompt' ? '提示词映射' : '图片槽映射'} total={mappingRows.length} page={activeMappingPage} size={editorPageSize} onChange={setMappingPage} /></div></>}
              <p className="vwm-help">必须绑定实际值字段，不能覆盖节点连线。图片槽按显示顺序上传；每段视频的用途在生成视频时单独保存。</p>
            </>}
            {tab === 'parameters' && <><div className="vwm-info compact">编辑实际节点中的默认值；保持数字、文字、布尔类型，不改其他输入或连线。</div><div className="vwm-parameter-list">{parameterEntries.slice(activeParameterPage * editorPageSize, (activeParameterPage + 1) * editorPageSize).map(([name, binding]) => {
              let value: unknown; let issue = '';
              try { value = readVideoWorkflowInput(draft.workflowJson, binding); if (!['number', 'string', 'boolean'].includes(typeof value)) issue = '此字段为复杂 JSON 值，请到 API JSON 页编辑。'; }
              catch (cause) { issue = errorText(cause); }
              return <div className="vwm-parameter-item" key={name}><div className="vwm-row"><strong>{name}</strong><div><span className="vwm-value-type">{issue ? '待绑定实际值' : `原类型：${typeof value === 'number' ? '数字' : typeof value === 'boolean' ? '布尔' : '文字'}`}</span><button type="button" className="btn small" aria-label={`移除参数 ${name}`} onClick={() => { const parameters = { ...draft.mapping.parameters }; delete parameters[name]; const edits = { ...parameterEdits }; delete edits[name]; setParameterEdits(edits); patchMapping({ parameters }); }}>移除</button></div></div><div className="vwm-parameter-fields"><BindingFields binding={binding} nodes={parsed.nodes} label={`参数 ${name} `} onChange={(next) => parameterBinding(name, next)} /><label className="field"><span>工作流默认值</span>{typeof value === 'boolean' && !issue ? <select aria-label={`参数 ${name} 默认值`} value={parameterEdits[name] ?? String(value)} onChange={(event) => { setParameterEdits({ ...parameterEdits, [name]: event.target.value }); clearNotice(); }}><option value="true">true（开启）</option><option value="false">false（关闭）</option></select> : <input aria-label={`参数 ${name} 默认值`} disabled={Boolean(issue)} inputMode={typeof value === 'number' ? 'decimal' : 'text'} value={parameterEdits[name] ?? scalarText(value)} title={issue || undefined} placeholder={issue ? '请先绑定实际值' : ''} onChange={(event) => { setParameterEdits({ ...parameterEdits, [name]: event.target.value }); clearNotice(); }} />}</label></div>{issue && <p className="vwm-inline-warning">{issue}</p>}{Object.prototype.hasOwnProperty.call(parameterEdits, name) && <button type="button" className="vwm-text-button" onClick={() => { const next = { ...parameterEdits }; delete next[name]; setParameterEdits(next); }}>撤销这个值的编辑</button>}</div>;
            })}{!parameterEntries.length && <div className="vwm-empty">尚无参数映射。导入时会识别常见种子、步数、尺寸和帧率；也可以手动添加实际字段。</div>}</div><div className="vwm-parameter-add"><input aria-label="新视频工作流参数名" value={parameterName} placeholder="参数名，例如 seed / steps / fps" onChange={(event) => setParameterName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addParameter(); } }} /><button type="button" className="btn small" disabled={!parameterName.trim()} onClick={addParameter}>添加参数</button></div><Pager label="参数映射" total={parameterEntries.length} page={activeParameterPage} size={editorPageSize} onChange={setParameterPage} /></>}
            {tab === 'json' && <><p className="vwm-help">仅接受 ComfyUI 导出的 API 节点 JSON；普通画布的 widgets 值不会被猜测转换。保存原文不会重置自定义映射。</p><label className="field vwm-json-field"><span>API JSON 编辑稿</span><textarea aria-label="视频工作流 API JSON 编辑稿" spellCheck={false} value={draft.workflowJson} onChange={(event) => patchDraft({ workflowJson: event.target.value })} /></label><div className="vwm-json-actions"><button type="button" className="btn small" onClick={() => { try { patchDraft({ workflowJson: formatVideoWorkflowJson(draft.workflowJson) }); } catch (cause) { setError(errorText(cause)); } }}>格式化 JSON</button><button type="button" className="btn small" onClick={recognize}>重新识别映射</button><button type="button" className="btn small" disabled={dirty || !savedDraft} onClick={exportJson}>导出 API JSON</button></div><p className="vwm-help">认证信息只放在连接设置中。导出包含原始节点与参数，不包含连接配置；软件自定义映射在本地设置中独立保存。</p></>}
          </div>
        </> : <div className="vwm-editor-empty"><h3>管理多份视频工作流</h3><p>导入现有 ComfyUI API JSON，或新建一份草稿。每份工作流独立保存节点映射和默认参数；图片用途在生成视频时按分段选择。</p><button type="button" className="btn primary" onClick={() => fileRef.current?.click()}>导入 API JSON</button></div>}</main>
      </div>
      <div className={`vwm-notice${error ? ' error' : ''}`} role={error ? 'alert' : 'status'} title={error || message || undefined}>{error || message || (dirty ? '当前有未保存编辑；切换或关闭时会提示确认。' : '保存后可在视频导演台选择；不会改动历史任务的冻结工作流。')}</div>
      <footer className="vwm-footer"><span>{draft ? `${parsed.issues.length ? '待配置' : '映射可用'} · ${current?.id === draft.id ? '当前工作流' : '仅选中编辑'}` : '导入新增，不覆盖已有工作流'}</span><div><button type="button" className="btn" disabled={!draft || !savedDraft || dirty || Boolean(parsed.issues.length) || current?.id === draft?.id} onClick={activate}>设为当前</button><button type="button" className="btn primary" disabled={!draft || (!dirty && Boolean(savedDraft))} onClick={save}>保存工作流</button><button type="button" className="btn" onClick={requestClose}>完成</button></div></footer>
      <input ref={fileRef} type="file" accept=".json,application/json" hidden aria-label="导入视频工作流 API JSON 文件" onChange={(event) => { void importFile(event); }} />
      {confirmation && <div className="vwm-confirm-backdrop"><section className="vwm-confirm" role="alertdialog" aria-modal="true" aria-label={confirmation.title}><h3>{confirmation.title}</h3><p>{confirmation.body}</p><div><button type="button" className="btn" onClick={() => setConfirmation(undefined)}>取消</button><button type="button" className={`btn ${confirmation.danger ? 'danger' : 'primary'}`} onClick={() => { const action = confirmation.action; setConfirmation(undefined); action(); }}>{confirmation.actionLabel}</button></div></section></div>}
    </section>
  </div>;
  return typeof document === 'undefined' ? modal : createPortal(modal, document.body);
}
