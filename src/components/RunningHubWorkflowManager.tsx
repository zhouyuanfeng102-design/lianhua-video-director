import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { RunningHubVideoConfig, RunningHubVideoFieldControl, RunningHubVideoInputBinding, RunningHubVideoNodeInfo, RunningHubVideoWorkflow } from '../runningHubVideoTypes';
import {
  copyRunningHubVideoWorkflow, createRunningHubTutorialVideoWorkflow, createRunningHubVideoWorkflow,
  deleteRunningHubVideoWorkflow, ensureRunningHubVideoRequestNode, exportRunningHubVideoWorkflow, importRunningHubVideoWorkflow,
  isRunningHubVideoWorkflowReady, readRunningHubVideoRequest, saveRunningHubVideoWorkflow,
  setActiveRunningHubVideoWorkflow, updateRunningHubVideoNodeValue, updateRunningHubVideoRequestField,
  validateRunningHubVideoWorkflow,
} from '../runningHubVideo';
import { listRunningHubVideoNodes, mergeRunningHubVideoNodeCatalog, parseRunningHubVideoNodes } from '../runningHubVideoNodes';
import { discoverRunningHubVideoNodes } from '../services/runningHubVideoDiscovery';
import { selectRunningHubVideoFieldChoices } from '../runningHubVideoFieldChoices';
import { bindRunningHubImageCount, isRunningHubImageCountField, runningHubImageCountConflict, syncRunningHubImageSlots } from '../runningHubImageSlots';
import { resolveRunningHubVideoImageProtocol } from '../runningHubImageProtocol';
import { syncRunningHubAudioSlots } from '../runningHubAudioSlots';
import { listRunningHubLoraSlots, listRunningHubOtherFields } from '../runningHubGenerationExtras';
import { RunningHubGenerationExtras } from './RunningHubGenerationExtras';
import { bindRunningHubVideoOutput, isRunningHubVideoMegapixelsBinding, runningHubVideoOutputCandidates, runningHubVideoOutputConflict, runningHubVideoOutputControl, runningHubVideoOutputDraft, runningHubVideoOutputFields, setRunningHubVideoFieldControl, type RunningHubVideoOutputKey } from '../runningHubVideoOutput';
import '../videoWorkflowManager.css';
import '../runningHubVideoSettings.css';

export interface RunningHubWorkflowManagerProps {
  config: RunningHubVideoConfig;
  getCurrentConfig?: () => RunningHubVideoConfig;
  onChange: (next: RunningHubVideoConfig) => void;
  onClose: () => void;
}
type EditorTab = 'basic' | 'mapping' | 'output' | 'parameters' | 'runtime' | 'json';
type MappingTab = 'prompt' | 'images' | 'audios';
type OutputSection = 'common' | 'lora' | 'other';
interface Confirmation { title: string; body: string; actionLabel: string; danger?: boolean; action: () => void }
const megapixelPreset: RunningHubVideoFieldControl = {
  kind: 'select', unit: 'MP', options: ['0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.9', '1.0'], min: 0.2, max: 1, step: 0.1,
  optionLabels: { '0.2': '608 × 352', '0.3': '736 × 416', '0.4': '864 × 480', '0.5': '960 × 544', '0.6': '1056 × 608', '0.7': '1152 × 640', '0.8': '1216 × 672', '0.9': '1280 × 736', '1.0': '1376 × 768' }, optionLabelAspectRatio: '16:9',
};
const isFixedMegapixelPreset = (control: RunningHubVideoFieldControl | undefined) => Boolean(control
  && control.kind === 'select' && control.unit === 'MP' && control.min === 0.2 && control.max === 1 && control.step === 0.1
  && control.options?.join(',') === megapixelPreset.options!.join(','));
interface OutputControlEdit { kind: RunningHubVideoFieldControl['kind']; unit?: 'MP'; options: string; min: string; max: string; step: string; optionLabels?: Record<string, string>; optionLabelAspectRatio?: string }
const controlEdit = (control: RunningHubVideoFieldControl): OutputControlEdit => ({ kind: control.kind, unit: control.unit,
  options: control.options?.join(', ') || '', min: control.min === undefined ? '' : String(control.min),
  max: control.max === undefined ? '' : String(control.max), step: control.step === undefined ? '' : String(control.step),
  optionLabels: control.optionLabels, optionLabelAspectRatio: control.optionLabelAspectRatio });
const controlOptions = (value: string): string[] => [...new Set(value.split(/[,，\n]/u).map((option) => option.trim()).filter(Boolean))];
const materializeControl = (edit: OutputControlEdit): RunningHubVideoFieldControl => {
  const control: RunningHubVideoFieldControl = { kind: edit.kind, ...(edit.unit ? { unit: edit.unit } : {}) };
  if (edit.kind === 'select') {
    control.options = controlOptions(edit.options);
    if (edit.optionLabels) control.optionLabels = edit.optionLabels;
    if (edit.optionLabelAspectRatio) control.optionLabelAspectRatio = edit.optionLabelAspectRatio;
  }
  for (const key of ['min', 'max', 'step'] as const) {
    if (!edit[key].trim()) continue;
    const value = Number(edit[key]);
    if (!Number.isFinite(value) || key === 'step' && value <= 0) throw new Error('选项范围请输入有效数字，步长必须大于 0。');
    control[key] = value;
  }
  if (control.min !== undefined && control.max !== undefined && control.min > control.max) throw new Error('选项最小值不能大于最大值。');
  return control;
};
const tabs: Array<[EditorTab, string]> = [['basic', '基本信息'], ['mapping', '输入映射'], ['output', '生成参数'], ['parameters', '节点参数'], ['runtime', '云端运行'], ['json', '请求 JSON']];
const jsonKey = (value: unknown) => JSON.stringify(value);
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请检查云端工作流设置。';
const valueText = (value: unknown) => typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
const bindingKey = (binding: RunningHubVideoInputBinding) => JSON.stringify([binding.nodeId, binding.inputName]);
const prepareWorkflowDraft = (workflow: RunningHubVideoWorkflow) => syncRunningHubAudioSlots(syncRunningHubImageSlots(runningHubVideoOutputDraft(workflow).workflow));
const uiFontScale = () => {
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

/** A draft editor: merely highlighting/importing a workflow never submits or activates it. */
export function RunningHubWorkflowManager({ config, getCurrentConfig, onChange, onClose }: RunningHubWorkflowManagerProps) {
  const initial = config.workflows.find((workflow) => workflow.id === config.activeWorkflowId) || config.workflows[0];
  const [draft, setDraft] = useState<RunningHubVideoWorkflow | undefined>(() => initial ? prepareWorkflowDraft(structuredClone(initial)) : undefined);
  const [baseline, setBaseline] = useState(() => initial ? jsonKey(initial) : '');
  const [tab, setTab] = useState<EditorTab>('basic');
  const [mappingTab, setMappingTab] = useState<MappingTab>('prompt');
  const [outputSection, setOutputSection] = useState<OutputSection>('common');
  const [libraryPage, setLibraryPage] = useState(0);
  const [mappingPage, setMappingPage] = useState(0);
  const [parameterPage, setParameterPage] = useState(0);
  const [search, setSearch] = useState('');
  const [nodeEdits, setNodeEdits] = useState<Record<string, string>>({});
  const [outputControlEdits, setOutputControlEdits] = useState<Record<string, OutputControlEdit>>({});
  const [customOutputDefaults, setCustomOutputDefaults] = useState<Record<string, boolean>>({});
  const [retainSecondsEdit, setRetainSecondsEdit] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importName, setImportName] = useState('');
  const [importing, setImporting] = useState(false);
  const [nodeDialog, setNodeDialog] = useState<'json' | 'manual' | null>(null);
  const [nodeSource, setNodeSource] = useState('');
  const [nodeFileBusy, setNodeFileBusy] = useState(false);
  const [manualNode, setManualNode] = useState({ nodeId: '', fieldName: '', value: '', type: 'string' });
  const [nodeSearch, setNodeSearch] = useState('');
  const [mappingRange, setMappingRange] = useState<'common' | 'all'>('common');
  const [mappingSearch, setMappingSearch] = useState('');
  const [parameterRange, setParameterRange] = useState<'common' | 'all'>('common');
  const [outputRange, setOutputRange] = useState<'common' | 'all'>('common');
  const [outputSearch, setOutputSearch] = useState('');
  const [outputControlKey, setOutputControlKey] = useState<RunningHubVideoOutputKey | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [fontScale, setFontScale] = useState(uiFontScale);
  const [windowHeight, setWindowHeight] = useState(() => typeof window === 'undefined' ? 900 : window.innerHeight);
  const pageSize = windowHeight < 780 || Number(fontScale) > 1.1 ? 1 : 2;
  const dialogRef = useRef<HTMLElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nodeFileRef = useRef<HTMLInputElement>(null);
  const baseStoredRef = useRef(initial ? jsonKey(initial) : '');
  const mountedRef = useRef(true);
  const importEpoch = useRef(0);
  const nodeEpoch = useRef(0);
  const discoveryEpoch = useRef(0);
  const discoveryController = useRef<AbortController>();
  const extrasDialogClose = useRef<(() => void) | null>(null);
  const dirty = Boolean(draft && (jsonKey(draft) !== baseline || Object.keys(nodeEdits).length || Object.keys(outputControlEdits).length || retainSecondsEdit !== null));
  const latest = useRef({ config, getCurrentConfig, onChange, onClose, draft, dirty, confirmation, importOpen, importText, nodeDialog, outputControlKey, close: () => {}, cancelImport: () => {}, closeNodes: () => {} });
  latest.current = { config, getCurrentConfig, onChange, onClose, draft, dirty, confirmation, importOpen, importText, nodeDialog, outputControlKey, close: () => requestClose(), cancelImport: () => cancelImport(), closeNodes: () => closeNodeDialog() };
  const currentConfig = () => latest.current.getCurrentConfig?.() || latest.current.config;
  const active = config.workflows.find((workflow) => workflow.id === config.activeWorkflowId);
  const savedDraft = config.workflows.find((workflow) => workflow.id === draft?.id);
  const outputDraftIssue = draft ? runningHubVideoOutputDraft(draft).issue : '';
  const filtered = config.workflows.filter((workflow) => !search.trim() || `${workflow.name} ${workflow.remoteId}`.toLowerCase().includes(search.trim().toLowerCase()));
  const currentLibraryPage = Math.min(libraryPage, Math.max(0, Math.ceil(filtered.length / 4) - 1));
  const parsed = useMemo(() => {
    if (!draft) return { request: undefined, issues: [] as string[] };
    const issues = validateRunningHubVideoWorkflow(draft);
    try { return { request: readRunningHubVideoRequest(draft.requestTemplate), issues }; }
    catch { return { request: undefined, issues }; }
  }, [draft]);
  // Invalid drafts stay inspectable in JSON; malformed rows must not crash the editor.
  const nodeRows = useMemo(() => listRunningHubVideoNodes(draft?.requestTemplate || '', draft?.nodeCatalog), [draft?.requestTemplate, draft?.nodeCatalog]);
  const imageProtocol = draft ? resolveRunningHubVideoImageProtocol(draft) : undefined;
  const imageCount = imageProtocol?.imageCount;
  const imageCountKey = imageCount ? bindingKey(imageCount) : '';
  const imageCountCandidates = nodeRows.filter(isRunningHubImageCountField);
  const mappingRows = draft?.mapping[mappingTab] || [];
  const mappingChoices = selectRunningHubVideoFieldChoices(nodeRows, mappingTab, { showAll: mappingRange === 'all', search: mappingSearch, keepBindings: mappingRows, catalog: draft?.nodeCatalog });
  const mappingCommon = selectRunningHubVideoFieldChoices(nodeRows, mappingTab, { keepBindings: mappingRows, catalog: draft?.nodeCatalog });
  const requestedBindings = (parsed.request?.nodeInfoList || []).flatMap((node) => node && typeof node.nodeId === 'string' && typeof node.fieldName === 'string' ? [{ nodeId: node.nodeId, inputName: node.fieldName }] : []);
  const parameterKeep = [...requestedBindings, ...Object.values(draft?.mapping.parameters || {}), ...(imageCount ? [imageCount] : []), ...nodeRows.filter((node) => Object.prototype.hasOwnProperty.call(nodeEdits, bindingKey({ nodeId: node.nodeId, inputName: node.fieldName }))).map((node) => ({ nodeId: node.nodeId, inputName: node.fieldName }))];
  const parameterRows = selectRunningHubVideoFieldChoices(nodeRows, 'parameters', { showAll: parameterRange === 'all', keepBindings: parameterKeep, catalog: draft?.nodeCatalog });
  const filteredNodes = parameterRows.filter((node) => !nodeSearch.trim() || `${node.nodeId}.${node.fieldName} ${node.description || ''}`.toLowerCase().includes(nodeSearch.trim().toLowerCase()));
  const currentParameterPage = Math.min(parameterPage, Math.max(0, Math.ceil(filteredNodes.length / pageSize) - 1));
  const currentMappingPage = Math.min(mappingPage, Math.max(0, Math.ceil(mappingRows.length / pageSize) - 1));

  useEffect(() => {
    mountedRef.current = true;
    if (typeof document === 'undefined') return () => { mountedRef.current = false; importEpoch.current += 1; nodeEpoch.current += 1; discoveryController.current?.abort(); };
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialogRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    const onKey = (event: KeyboardEvent) => {
      const scope = dialogRef.current?.querySelector<HTMLElement>('[role="alertdialog"]')
        || dialogRef.current?.querySelector<HTMLElement>('.rhv-import-dialog') || dialogRef.current;
      if (!scope) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (latest.current.confirmation) setConfirmation(undefined);
        else if (latest.current.importOpen) latest.current.cancelImport();
        else if (latest.current.nodeDialog) latest.current.closeNodes();
        else if (extrasDialogClose.current) extrasDialogClose.current();
        else if (latest.current.outputControlKey) setOutputControlKey(null);
        else latest.current.close();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = [...scope.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter((element) => element.getClientRects().length && !element.closest('[hidden]'));
      const first = elements[0]; const last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || !scope.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !scope.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { mountedRef.current = false; importEpoch.current += 1; nodeEpoch.current += 1; discoveryController.current?.abort(); document.removeEventListener('keydown', onKey, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const shell = document.querySelector('.app-shell') || document.documentElement;
    const observer = new MutationObserver(() => setFontScale(uiFontScale()));
    observer.observe(shell, { attributes: true, attributeFilter: ['style', 'class'] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const resize = () => { setWindowHeight(window.innerHeight); setMappingPage(0); setParameterPage(0); };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    if (typeof document === 'undefined' || (!confirmation && !importOpen && !nodeDialog && !outputControlKey)) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const selector = confirmation ? '[role="alertdialog"] button' : outputControlKey ? '.rhv-output-control-dialog select' : nodeDialog === 'manual' ? '.rhv-node-dialog input' : '.rhv-import-dialog textarea';
    dialogRef.current?.querySelector<HTMLElement>(selector)?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [confirmation, importOpen, nodeDialog, outputControlKey]);
  useEffect(() => {
    cancelDiscovery();
    nodeEpoch.current += 1; setNodeFileBusy(false);
  }, [draft?.id, draft?.remoteId, draft?.runKind, config.baseUrl, config.apiKey]);

  function clearNotice() { setError(''); setMessage(''); }
  function apply(next: RunningHubVideoConfig) { latest.current.config = next; latest.current.onChange(next); }
  function loadDraft(workflow: RunningHubVideoWorkflow | undefined, saved = true) {
    cancelDiscovery(); nodeEpoch.current += 1; setNodeDialog(null); setNodeFileBusy(false); setNodeSearch(''); setNodeSource(''); setManualNode({ nodeId: '', fieldName: '', value: '', type: 'string' });
    setMappingRange('common'); setMappingSearch(''); setParameterRange('common');
    setOutputRange('common'); setOutputSearch('');
    if (workflow?.id !== latest.current.draft?.id) setOutputSection('common');
    extrasDialogClose.current = null;
    setOutputControlKey(null);
    const copy = workflow ? prepareWorkflowDraft(structuredClone(workflow)) : undefined;
    setDraft(copy); setBaseline(saved && workflow ? jsonKey(workflow) : '');
    baseStoredRef.current = saved && workflow ? jsonKey(workflow) : '';
    setNodeEdits({}); setOutputControlEdits({}); setCustomOutputDefaults({}); setRetainSecondsEdit(null); setMappingPage(0); setParameterPage(0); clearNotice();
  }
  function patchDraft(patch: Partial<RunningHubVideoWorkflow>) {
    if ('remoteId' in patch || 'runKind' in patch) cancelDiscovery();
    const identityChanged = Boolean(draft && (patch.remoteId !== undefined && patch.remoteId !== draft.remoteId || patch.runKind !== undefined && patch.runKind !== draft.runKind));
    if (identityChanged) {
      nodeEpoch.current += 1; setNodeFileBusy(false); setNodeDialog(null); setNodeSource('');
      setManualNode({ nodeId: '', fieldName: '', value: '', type: 'string' });
      setMappingRange('common'); setMappingSearch(''); setParameterRange('common'); setNodeSearch(''); setParameterPage(0);
      setOutputRange('common'); setOutputSearch('');
    }
    setDraft((value) => value ? prepareWorkflowDraft({ ...value, ...patch, ...(identityChanged ? { nodeCatalog: undefined } : {}) }) : value); clearNotice();
    if (identityChanged && draft?.nodeCatalog?.length) setMessage('云端 ID / 类型已改变，旧节点目录已清空；已有请求和映射未删除，请重新读取节点后核对。');
  }
  function patchMapping(patch: Partial<RunningHubVideoWorkflow['mapping']>) {
    if (!draft) return;
    try {
      const mapping = { ...draft.mapping, ...patch };
      if (imageCount && [...mapping.prompt, ...mapping.images, ...(mapping.audios || []), ...Object.values(mapping.parameters || {})].some((binding) => bindingKey(binding) === imageCountKey)) {
        throw new Error(`${imageCount.nodeId}.${imageCount.inputName} 已用于每段实际图片数量，请先在参考图片槽中解除数量绑定。`);
      }
      let requestTemplate = draft.requestTemplate;
      const assigned = new Set<string>();
      for (const binding of [...mapping.prompt, ...mapping.images, ...(mapping.audios || []), ...Object.values(mapping.parameters || {}), ...(mapping.imageCount ? [mapping.imageCount] : [])]) {
        if (binding.nodeId.trim() && binding.inputName.trim()) {
          const key = bindingKey(binding);
          if (assigned.has(key)) throw new Error(`${binding.nodeId}.${binding.inputName} 已绑定其他输入用途，请先解除原绑定。`);
          assigned.add(key);
        }
        const node = nodeRows.find((row) => row.nodeId === binding.nodeId && row.fieldName === binding.inputName);
        if (node) requestTemplate = ensureRunningHubVideoRequestNode(requestTemplate, node);
      }
      setDraft((value) => value ? prepareWorkflowDraft({ ...value, requestTemplate, mapping }) : value); clearNotice();
    } catch (cause) { setError(errorText(cause)); }
  }
  function guardDiscard(action: () => void, body = '切换后会放弃当前尚未保存的编辑，已保存版本和历史任务保持不变。') {
    if (!latest.current.dirty) { action(); return; }
    setConfirmation({ title: '有未保存的云端工作流编辑', body, actionLabel: '放弃编辑并继续', danger: true, action });
  }
  function requestClose() { guardDiscard(() => { cancelDiscovery(); latest.current.onClose(); }, '关闭后会放弃尚未保存的工作流编辑。已经点击“保存工作流”的内容会保留。'); }
  function cancelImport() {
    const close = () => { setImportOpen(false); setImportText(''); setImportName(''); importEpoch.current += 1; setImporting(false); clearNotice(); };
    if (!latest.current.importText.trim()) { close(); return; }
    setConfirmation({ title: '放弃尚未导入的文本？', body: '只清空这次粘贴的文本，不删除已保存的云端工作流。', actionLabel: '放弃导入文本', action: close });
  }
  function materializeDraft(): RunningHubVideoWorkflow {
    if (!draft) throw new Error('请选择或新建云端工作流。');
    let configured = draft;
    for (const [key, edit] of Object.entries(outputControlEdits)) {
      const [nodeId, inputName] = JSON.parse(key) as [string, string];
      configured = setRunningHubVideoFieldControl(configured, { nodeId, inputName }, materializeControl(edit));
    }
    let requestTemplate = draft.requestTemplate;
    for (const node of nodeRows) {
      const binding = { nodeId: String(node.nodeId), inputName: String(node.fieldName) };
      const key = bindingKey(binding);
      if (key === imageCountKey) continue;
      if (Object.prototype.hasOwnProperty.call(nodeEdits, key)) requestTemplate = updateRunningHubVideoNodeValue(ensureRunningHubVideoRequestNode(requestTemplate, node), binding, nodeEdits[key]);
    }
    if (retainSecondsEdit !== null) requestTemplate = updateRunningHubVideoRequestField(requestTemplate, 'retainSeconds', retainSecondsEdit === '' ? undefined : Number(retainSecondsEdit));
    return prepareWorkflowDraft({ ...configured, requestTemplate });
  }
  function switchTab(next: EditorTab) {
    try { if (Object.keys(nodeEdits).length || Object.keys(outputControlEdits).length || retainSecondsEdit !== null) { setDraft(materializeDraft()); setNodeEdits({}); setOutputControlEdits({}); setRetainSecondsEdit(null); } setTab(next); setError(''); }
    catch (cause) { setError(errorText(cause)); }
  }
  function uniqueName(proposed: string) {
    const names = new Set(currentConfig().workflows.map((workflow) => workflow.name));
    if (!names.has(proposed)) return proposed;
    let suffix = 2; while (names.has(`${proposed} (${suffix})`)) suffix += 1;
    return `${proposed} (${suffix})`;
  }
  function create(tutorial = false) {
    guardDiscard(() => { const workflow = tutorial ? createRunningHubTutorialVideoWorkflow() : createRunningHubVideoWorkflow(); workflow.name = uniqueName(workflow.name); loadDraft(workflow, false); setTab('basic'); setMessage(tutorial ? '已载入教程结构：138.value 对应提示词、137.image 对应参考图。原教程剧情和图片未导入，请核对自己的应用 ID 与节点。' : '新工作流为编辑稿；保存并明确设为当前后，才会被后续生成使用。'); });
  }
  function copy() {
    try { const workflow = materializeDraft(); const copied = copyRunningHubVideoWorkflow(workflow, uniqueName(`${workflow.name} 副本`)); loadDraft(copied, false); setTab('basic'); setMessage('已复制为独立编辑稿；原工作流及当前选择不变。'); }
    catch (cause) { setError(errorText(cause)); }
  }
  function save() {
    clearNotice();
    try {
      const workflow = materializeDraft(); const current = currentConfig();
      const persisted = current.workflows.find((entry) => entry.id === workflow.id);
      if (baseStoredRef.current && (!persisted || jsonKey(persisted) !== baseStoredRef.current)) throw new Error('这份工作流已在其他位置变化，请重新打开，避免覆盖新的设置。');
      const next = saveRunningHubVideoWorkflow(current, workflow);
      apply(next); loadDraft(next.workflows.find((entry) => entry.id === workflow.id));
      setMessage(isRunningHubVideoWorkflowReady(workflow) ? '已保存云端工作流；未提交云端任务，也未修改历史任务快照。' : '已保存为待配置草稿；补齐 ID、请求 JSON 与输入映射后才能设为当前。');
    } catch (cause) { setError(errorText(cause)); }
  }
  function activate() {
    if (!draft) return;
    if (dirty) { setError('请先保存，再设为当前云端工作流。'); return; }
    try {
      const current = currentConfig();
      const persisted = current.workflows.find((entry) => entry.id === draft.id);
      if (!persisted || jsonKey(persisted) !== baseStoredRef.current) throw new Error('这份工作流已在其他位置变化，请重新打开核对后再设为当前。');
      apply(setActiveRunningHubVideoWorkflow(current, draft.id)); setError(''); setMessage(`已设“${draft.name}”为当前云端工作流；不会自动开启连接或提交任务。`);
    }
    catch (cause) { setError(errorText(cause)); }
  }
  function remove() {
    if (!draft || !savedDraft) return;
    const id = draft.id; const before = currentConfig(); const beforeEntry = before.workflows.find((entry) => entry.id === id);
    const removingActive = before.activeWorkflowId === id;
    const preview = deleteRunningHubVideoWorkflow(before, id);
    const fallback = preview.workflows.find((entry) => entry.id === preview.activeWorkflowId);
    const note = !removingActive ? '当前工作流不变。' : fallback ? `删除后当前工作流切换为“${fallback.name}”。` : '删除后会关闭云端视频开关；请补齐并重新选择工作流后启用。';
    setConfirmation({ title: `删除“${savedDraft.name}”？`, body: `${note}仅删除这份本地配置，不删除 RunningHub 云端工作流、项目素材或历史任务。${dirty ? '尚未保存的编辑也会放弃。' : ''}`, actionLabel: '确认删除云端工作流', danger: true, action: () => {
      const current = currentConfig(); const entry = current.workflows.find((item) => item.id === id);
      if (!entry || jsonKey(entry) !== jsonKey(beforeEntry) || current.activeWorkflowId !== before.activeWorkflowId || deleteRunningHubVideoWorkflow(current, id).activeWorkflowId !== preview.activeWorkflowId) { setError('工作流或当前选择已变化，请重新确认；没有删除设置。'); return; }
      const next = deleteRunningHubVideoWorkflow(current, id); apply(next);
      loadDraft(next.workflows.find((item) => item.id === next.activeWorkflowId) || next.workflows[0]); setMessage('已删除所选本地配置，云端工作流与历史素材未改动。');
    } });
  }
  function acceptImport(source: string, name: string) {
    clearNotice();
    try {
      const imported = importRunningHubVideoWorkflow(source, name);
      guardDiscard(() => {
        try {
          const current = currentConfig();
          // Import always receives a fresh ID from the library and appends against authoritative state.
          const workflow = { ...imported.workflow, name: uniqueName(imported.workflow.name) };
          const next = saveRunningHubVideoWorkflow(current, workflow);
          apply(next); loadDraft(next.workflows.find((entry) => entry.id === workflow.id));
          setImportOpen(false); setImportText(''); setImportName(''); setSearch(''); setLibraryPage(Math.floor(current.workflows.length / 4)); setTab('mapping');
          setMessage(['已新增导入工作流，未覆盖旧配置。请核对 ID、提示词与图片映射，再设为当前。', imported.baseUrl ? '导入来源地址未自动替换连接设置。' : '', ...imported.warnings].filter(Boolean).join(' '));
        } catch (cause) { setError(errorText(cause)); }
      });
    } catch (cause) { setError(errorText(cause)); }
  }
  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || importing) return;
    const epoch = ++importEpoch.current; setImporting(true); clearNotice();
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('导入文件超过 8 MB，请使用 RunningHub 请求 JSON 或 cURL 文本，不要导入素材文件。');
      const source = await file.text();
      if (!mountedRef.current || epoch !== importEpoch.current) return;
      acceptImport(source, file.name.replace(/\.(?:json|txt|curl)$/iu, ''));
    } catch (cause) { if (mountedRef.current && epoch === importEpoch.current) setError(errorText(cause)); }
    finally { if (mountedRef.current && epoch === importEpoch.current) setImporting(false); }
  }
  function cancelDiscovery() {
    discoveryEpoch.current += 1; discoveryController.current?.abort(); discoveryController.current = undefined;
    setDiscovering(false);
  }
  async function readCloudNodes() {
    if (!draft || discovering) return;
    clearNotice();
    const connection = currentConfig();
    const identity = { id: draft.id, remoteId: draft.remoteId, runKind: draft.runKind, baseUrl: connection.baseUrl, apiKey: connection.apiKey };
    const controller = new AbortController(); cancelDiscovery(); discoveryController.current = controller;
    const epoch = discoveryEpoch.current; setDiscovering(true);
    const stillCurrent = () => {
      const now = currentConfig(); const current = latest.current.draft;
      return mountedRef.current && !controller.signal.aborted && epoch === discoveryEpoch.current && current?.id === identity.id
        && current.remoteId === identity.remoteId && current.runKind === identity.runKind && now.baseUrl === identity.baseUrl && now.apiKey === identity.apiKey;
    };
    try {
      const result = await discoverRunningHubVideoNodes(identity, controller.signal);
      if (!stillCurrent()) return;
      setDraft((value) => value ? prepareWorkflowDraft({ ...value, nodeCatalog: mergeRunningHubVideoNodeCatalog(value.nodeCatalog, result.nodes) }) : value);
      setMessage(`已读取 ${result.nodes.length} 个节点字段；图片和音频文件输入已列为草稿槽位。用途及人物在生成视频时按分段设置，已有映射保留，保存后生效，未提交生成。${result.warnings.length ? ` ${result.warnings.join(' ')}` : ''}`);
    } catch (cause) { if (stillCurrent()) setError(errorText(cause)); }
    finally { if (mountedRef.current && epoch === discoveryEpoch.current) { setDiscovering(false); discoveryController.current = undefined; } }
  }
  function openNodeDialog(kind: 'json' | 'manual') { setNodeDialog(kind); clearNotice(); }
  function closeNodeDialog() { nodeEpoch.current += 1; setNodeDialog(null); setNodeFileBusy(false); clearNotice(); }
  function acceptNodeSource(source: string): boolean {
    if (!draft) return false;
    try {
      const result = parseRunningHubVideoNodes(source);
      if (!result.nodes.length) throw new Error('这份资料没有可选节点字段。请导出包含 inputs / class_type 的 API 格式，或手动填写实际节点 ID 和字段名。');
      setDraft((value) => value ? prepareWorkflowDraft({ ...value, nodeCatalog: mergeRunningHubVideoNodeCatalog(value.nodeCatalog, result.nodes) }) : value);
      closeNodeDialog(); setNodeSource(''); setManualNode({ nodeId: '', fieldName: '', value: '', type: 'string' }); setNodeSearch(''); setParameterPage(0);
        setMessage(`已加入 ${result.nodes.length} 个候选字段，图片和音频文件输入自动列为草稿槽位；既有槽位顺序和参数保留，用途及人物在生成视频时按分段设置，保存后才生效。${result.warnings.length ? ` ${result.warnings.join(' ')}` : ''}`);
      return true;
    } catch (cause) { setError(errorText(cause)); return false; }
  }
  function addManualNode() {
    clearNotice();
    try {
      if (!manualNode.nodeId.trim() || !manualNode.fieldName.trim()) throw new Error('请填写云端实际节点 ID 和字段名，不是节点的显示标题。');
      let value: string | number | boolean = manualNode.value;
      if (manualNode.type === 'number') {
        value = Number(manualNode.value);
        if (!manualNode.value.trim() || !Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error('请输入有效数字；长 ID 或大整数请改用文本类型，避免精度丢失。');
      } else if (manualNode.type === 'boolean') value = manualNode.value === 'true';
      const binding = { nodeId: manualNode.nodeId.trim(), inputName: manualNode.fieldName.trim() };
      if ((manualNode.type === 'image' || manualNode.type === 'audio') && draft && [...draft.mapping.prompt,
        ...(manualNode.type === 'audio' ? draft.mapping.images : draft.mapping.audios || []),
        ...Object.values(draft.mapping.parameters || {}), ...(imageCount ? [imageCount] : [])].some((entry) => bindingKey(entry) === bindingKey(binding))) {
        throw new Error('此字段已用于其他输入或参数，不能同时作为素材槽；请先核对原用途。');
      }
      if (acceptNodeSource(JSON.stringify([{ nodeId: binding.nodeId, fieldName: binding.inputName, fieldValue: value,
        ...(manualNode.type === 'audio' ? { audioUpload: true } : {}) }]))) {
        if (manualNode.type === 'image') setDraft((current) => {
          if (!current || current.mapping.images.some((entry) => bindingKey(entry) === bindingKey(binding))) return current;
          return prepareWorkflowDraft({ ...current, mapping: { ...current.mapping, images: [...current.mapping.images, { ...binding, role: 'general' }] } });
        });
        if (manualNode.type === 'audio') setDraft((current) => {
          if (!current || current.mapping.audios?.some((entry) => bindingKey(entry) === bindingKey(binding))) return current;
          return prepareWorkflowDraft({ ...current, mapping: { ...current.mapping, audios: [...(current.mapping.audios || []), binding] } });
        });
        const query = `${manualNode.nodeId.trim()}.${manualNode.fieldName.trim()}`;
        if (tab === 'parameters') { setParameterRange('all'); setNodeSearch(query); }
        else { setMappingRange('all'); setMappingSearch(query); }
      }
    } catch (cause) { setError(errorText(cause)); }
  }
  async function importNodeFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || nodeFileBusy || !draft) return;
    const epoch = ++nodeEpoch.current; const id = draft.id; const remoteId = draft.remoteId; const runKind = draft.runKind;
    setNodeFileBusy(true); clearNotice();
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('节点 JSON 超过 8 MB，请使用工作流 API 格式，不要导入图片或视频文件。');
      const source = await file.text();
      if (!mountedRef.current || epoch !== nodeEpoch.current || latest.current.draft?.id !== id || latest.current.draft?.remoteId !== remoteId || latest.current.draft?.runKind !== runKind) return;
      acceptNodeSource(source);
    } catch (cause) { if (mountedRef.current && epoch === nodeEpoch.current) setError(errorText(cause)); }
    finally { if (mountedRef.current && epoch === nodeEpoch.current) setNodeFileBusy(false); }
  }
  function useCatalogDefault(node: RunningHubVideoNodeInfo) {
    if (!draft) return;
    try { patchDraft({ requestTemplate: ensureRunningHubVideoRequestNode(draft.requestTemplate, node) }); }
    catch (cause) { setError(errorText(cause)); }
  }
  function nodeTools() {
    const label = tab === 'output' ? outputSection === 'lora' ? 'LoRA 槽位' : outputSection === 'other' ? '其它参数' : '已绑定快捷参数' : tab === 'parameters' ? parameterRange === 'all' ? '高级字段' : '常用参数及已配置字段' : mappingTab === 'images' ? '全部图片槽' : mappingTab === 'audios' ? '全部音频槽' : mappingRange === 'all' ? '高级字段' : '提示词候选';
    const count = tab === 'output' ? outputSection === 'lora' ? draft ? listRunningHubLoraSlots(draft).length : 0 : outputSection === 'other' ? draft ? listRunningHubOtherFields(draft).length : 0 : runningHubVideoOutputFields.filter((field) => draft?.mapping.parameters?.[field.key]).length : tab === 'parameters' ? filteredNodes.length : mappingTab === 'images' || mappingTab === 'audios' ? mappingRows.length : mappingChoices.length;
    return <div className="rhv-node-tools"><div><strong>{nodeRows.length ? `${label} ${count} 项` : '请求模板未提供节点字段'}</strong><span>{nodeRows.length ? `工作流内部字段共 ${nodeRows.length} 项 · 不等于接口外层参数` : 'nodeInfoList 为空时，需读取或导入真实节点资料'}</span></div><div><button type="button" className="btn small" disabled={discovering} onClick={() => { void readCloudNodes(); }}>{discovering ? '读取节点中…' : '读取云端节点'}</button>{discovering && <button type="button" className="btn small" onClick={() => { cancelDiscovery(); setMessage('已取消读取节点，工作流配置未改动。'); }}>取消读取</button>}<button type="button" className="btn small" onClick={() => openNodeDialog('json')}>导入节点 JSON</button><button type="button" className="btn small" onClick={() => openNodeDialog('manual')}>手动添加字段</button></div></div>;
  }
  function fieldFilters(mapping: boolean) {
    return <div className="rhv-field-filters"><label className="field"><span>显示范围（只筛选列表）</span><select aria-label={mapping ? '云端映射字段范围' : '云端参数字段范围'} value={mapping ? mappingRange : parameterRange} onChange={(event) => {
      const range = event.target.value === 'all' ? 'all' : 'common';
      if (mapping) setMappingRange(range); else { setParameterRange(range); setParameterPage(0); }
    }}><option value="common">{mapping ? mappingTab === 'prompt' ? '常用提示词及已绑定' : mappingTab === 'audios' ? '常用音频及已绑定' : '常用图片及已绑定' : '常用参数及已配置'}</option><option value="all">全部字段（高级）</option></select></label><label className="field"><span>搜索当前范围{mapping ? '（已绑定项保留）' : ''}</span><input aria-label={mapping ? '搜索云端映射字段' : '搜索云端节点字段'} value={mapping ? mappingSearch : nodeSearch} placeholder="节点 ID / 字段名 / 节点标题" onChange={(event) => {
      if (mapping) setMappingSearch(event.target.value); else { setNodeSearch(event.target.value); setParameterPage(0); }
    }} /></label></div>;
  }
  function exportWorkflow() {
    clearNotice();
    try {
      if (!draft || dirty || !savedDraft) throw new Error('请先保存工作流，再导出已保存的配置。');
      const source = exportRunningHubVideoWorkflow(draft);
      const url = URL.createObjectURL(new Blob([source], { type: 'application/json;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url;
      anchor.download = `${draft.name.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').slice(0, 100) || 'runninghub-video'}.runninghub.json`;
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage('已导出工作流 ID、请求参数和自定义映射；不包含连接 API Key。导出仅用于保存/导入配置，不会提交任务。');
    } catch (cause) { setError(errorText(cause)); }
  }
  function runtime(name: string, value: unknown) {
    if (!draft) return;
    try { patchDraft({ requestTemplate: updateRunningHubVideoRequestField(draft.requestTemplate, name, value) }); }
    catch (cause) { setError(errorText(cause)); }
  }
  function updateParameterBinding(binding: RunningHubVideoInputBinding, name: string) {
    if (!draft) return;
    if (bindingKey(binding) === imageCountKey) { setError('此字段按每段实际图片数量自动填写，不能同时绑定可覆盖参数。'); return; }
    if ((draft.mapping.audios || []).some((entry) => bindingKey(entry) === bindingKey(binding))) { setError('此字段已用于参考音频槽，不能同时绑定可覆盖参数。'); return; }
    const enteredKey = name.trim();
    const key = (enteredKey === 'width' || enteredKey === 'height') && isRunningHubVideoMegapixelsBinding(draft, binding) ? 'resolution' : enteredKey;
    if (['__proto__', 'prototype', 'constructor'].includes(key)) { setError('请使用普通参数名，例如 duration 或 seed。'); return; }
    const parameters = { ...draft.mapping.parameters };
    for (const [existingName, entry] of Object.entries(parameters)) if (bindingKey(entry) === bindingKey(binding)) delete parameters[existingName];
    if (key && parameters[key]) { setError('这个参数名已绑定其他字段，请使用不同名称。'); return; }
    if (key) parameters[key] = binding;
    patchMapping({ parameters });
  }
  function updateImageCountBinding(value: string) {
    if (!draft) return;
    try {
      const binding = value === 'auto' ? undefined : value === 'none' ? null : (() => {
        const [nodeId, inputName] = JSON.parse(value) as [string, string];
        return { nodeId, inputName };
      })();
      setDraft(prepareWorkflowDraft(bindRunningHubImageCount(materializeDraft(), binding)));
      setNodeEdits({}); setOutputControlEdits({}); setRetainSecondsEdit(null); clearNotice();
    } catch (cause) { setError(errorText(cause)); }
  }
  function updateOutputBinding(key: RunningHubVideoOutputKey, binding: RunningHubVideoInputBinding) {
    try {
      const next = bindRunningHubVideoOutput(materializeDraft(), key, binding);
      setDraft((current) => current ? prepareWorkflowDraft({ ...current, mapping: next.mapping, requestTemplate: next.requestTemplate, fieldControls: next.fieldControls }) : current);
      setNodeEdits({}); setOutputControlEdits({}); setRetainSecondsEdit(null); clearNotice();
    } catch (cause) { setError(errorText(cause)); }
  }
  function replaceOutputControl(binding: RunningHubVideoInputBinding, control?: RunningHubVideoFieldControl) {
    if (!draft) return;
    try {
      setDraft(prepareWorkflowDraft(setRunningHubVideoFieldControl(draft, binding, control)));
      setOutputControlEdits((current) => { const next = { ...current }; delete next[bindingKey(binding)]; return next; });
      setCustomOutputDefaults((current) => { const next = { ...current }; delete next[bindingKey(binding)]; return next; });
      clearNotice();
    } catch (cause) { setError(errorText(cause)); }
  }
  function outputField(key: RunningHubVideoOutputKey) {
    if (!draft) return null;
    const definition = runningHubVideoOutputFields.find((field) => field.key === key)!;
    const binding = draft.mapping.parameters?.[key];
    const candidates = runningHubVideoOutputCandidates(nodeRows, key, { showAll: outputRange === 'all', search: outputSearch, binding, catalog: draft.nodeCatalog, fieldControls: draft.fieldControls });
    const node = binding && nodeRows.find((entry) => entry.nodeId === binding.nodeId && entry.fieldName === binding.inputName);
    const incompatibleDimension = Boolean(binding && (key === 'width' || key === 'height') && isRunningHubVideoMegapixelsBinding(draft, binding));
    const bindingListed = binding && candidates.some((entry) => entry.nodeId === binding.nodeId && entry.fieldName === binding.inputName);
    const supported = Boolean(node && ['string', 'number'].includes(typeof node.fieldValue));
    const label = `RunningHub ${definition.label}`;
    const id = binding ? bindingKey(binding) : '';
    const control = runningHubVideoOutputControl(draft, key)?.control || { kind: key === 'steps' ? 'number' as const : 'text' as const };
    const edit = outputControlEdits[id] || controlEdit(draft.fieldControls?.[id] || control);
    const options = edit.kind === 'select' ? controlOptions(edit.options) : [];
    const strictOptions = edit.kind === 'select' && edit.unit === 'MP';
    const numeric = edit.kind === 'number';
    const value = node ? nodeEdits[id] ?? valueText(node.fieldValue) : '';
    const setDefault = (text: string) => { if (binding) { setNodeEdits({ ...nodeEdits, [id]: text }); clearNotice(); } };
    const numberProp = (field: 'min' | 'max' | 'step') => edit[field].trim() && Number.isFinite(Number(edit[field])) ? Number(edit[field]) : undefined;
    return <div className="rhv-output-field" key={key}><div className="vwm-row"><strong>{control.unit === 'MP' ? '像素（MP）' : `${definition.label}${key === 'duration' ? '（秒）' : ''}`}</strong><span className="vwm-value-type">{control.unit === 'MP' ? '百万像素' : key}</span></div>
      <label className="field"><span>实际节点与字段</span><select aria-label={`${label}节点字段`} value={binding ? bindingKey(binding) : '["",""]'} onChange={(event) => { const [nodeId, inputName] = JSON.parse(event.target.value) as [string, string]; updateOutputBinding(key, { nodeId, inputName }); }}>
        <option value='["",""]'>未绑定（不动态覆盖此参数）</option>
        {binding && (!node || !bindingListed) && <option value={bindingKey(binding)} disabled={incompatibleDimension}>{binding.nodeId}.{binding.inputName} · {incompatibleDimension ? '旧绑定，请改用像素（MP）' : '目录中缺失'}</option>}
        {candidates.map((entry) => { const candidate = { nodeId: entry.nodeId, inputName: entry.fieldName }; const conflict = runningHubVideoOutputConflict(draft, key, candidate); return <option key={bindingKey(candidate)} value={bindingKey(candidate)} disabled={Boolean(conflict) || !['string', 'number'].includes(typeof entry.fieldValue)}>{entry.nodeId}.{entry.fieldName}{typeof entry.description === 'string' && entry.description ? ` · ${entry.description}` : ''}{conflict ? ` · 已用于${conflict}` : ''}</option>; })}
      </select></label>
      <label className="field"><span>工作流默认值 · {node ? typeof node.fieldValue : '绑定后可编辑'}</span>{edit.kind === 'select' && supported ? <select aria-label={`${label}默认值`} value={!strictOptions && customOutputDefaults[id] ? '__custom__' : value} onChange={(event) => {
        if (strictOptions && !options.includes(event.target.value)) return;
        const custom = event.target.value === '__custom__'; setCustomOutputDefaults({ ...customOutputDefaults, [id]: custom }); if (!custom) setDefault(event.target.value);
      }}>{!options.includes(value) && <option value={value} disabled={strictOptions}>当前值：{value || '空'}</option>}{options.map((option) => <option key={option} value={option}>{option}{control.unit === 'MP' ? ' MP' : ''}{control.optionLabels?.[option] ? `（${control.optionLabels[option]}）` : ''}</option>)}{!strictOptions && <option value="__custom__">自定义值…</option>}</select> : <input aria-label={`${label}默认值`} type={numeric ? 'number' : 'text'} inputMode={numeric ? 'decimal' : 'text'} min={numeric ? numberProp('min') : undefined} max={numeric ? numberProp('max') : undefined} step={numeric ? numberProp('step') ?? 'any' : undefined} disabled={!supported} value={value} placeholder="先选择实际节点字段" onChange={(event) => setDefault(event.target.value)} />}</label>
      {edit.kind === 'select' && !strictOptions && customOutputDefaults[id] && <label className="field"><span>自定义默认值</span><input aria-label={`${label}自定义默认值`} value={value} onChange={(event) => setDefault(event.target.value)} /></label>}
      <p className="vwm-help">{control.unit === 'MP' ? `MP 为百万像素，按节点数值提交。${control.optionLabels ? `括号为 ${control.optionLabelAspectRatio || '当前比例'} 节点尺寸，二采后以成片为准。` : ''}` : definition.hint}</p>
      {(key === 'resolution' || key === 'aspect_ratio' || key === 'steps') && binding && supported && <button type="button" className="vwm-text-button rhv-control-settings-button" aria-label={`${label}输入选项设置`} onClick={() => setOutputControlKey(key)}>输入选项设置</button>}
    </div>;
  }
  function outputControlDialog() {
    if (!draft || !outputControlKey) return null;
    const binding = draft.mapping.parameters?.[outputControlKey];
    if (!binding) return null;
    const definition = runningHubVideoOutputFields.find((field) => field.key === outputControlKey)!;
    const label = `RunningHub ${definition.label}`;
    const id = bindingKey(binding);
    const control = runningHubVideoOutputControl(draft, outputControlKey)?.control || { kind: 'text' as const };
    const edit = outputControlEdits[id] || controlEdit(draft.fieldControls?.[id] || control);
    const fixedPreset = isFixedMegapixelPreset(draft.fieldControls?.[id]);
    const setControlEdit = (patch: Partial<OutputControlEdit>) => { if (fixedPreset) return; setOutputControlEdits({ ...outputControlEdits, [id]: { ...edit, ...patch } }); clearNotice(); };
    return <div className="rhv-import-backdrop"><section className="rhv-import-dialog rhv-output-control-dialog" role="dialog" aria-modal="true" aria-label={`${label}输入选项设置`}>
      <header><h3>{definition.label} · 输入选项设置</h3><button type="button" className="btn small" onClick={() => setOutputControlKey(null)}>关闭选项编辑</button></header>
      <div className="rhv-control-fields">
        {control.unit === 'MP' && <button type="button" className="btn small" onClick={() => replaceOutputControl(binding, megapixelPreset)}>使用 0.2–1.0 MP 选项</button>}
        <label className="field"><span>输入方式</span><select aria-label={`${label}输入方式`} value={edit.kind} disabled={fixedPreset} onChange={(event) => setControlEdit({ kind: event.target.value as RunningHubVideoFieldControl['kind'] })}><option value="text">文本</option><option value="number">数值</option><option value="select">{control.unit === 'MP' ? '固定选项' : '可选项与自定义'}</option></select></label>
        {edit.kind === 'select' && <label className="field"><span>{fixedPreset ? '固定档位' : '可选值（逗号分隔）'}</span><textarea aria-label={`${label}可选值`} rows={2} readOnly={fixedPreset} value={edit.options} onChange={(event) => setControlEdit({ options: event.target.value })} /></label>}
        {(edit.kind === 'number' || edit.unit === 'MP') && <div className="rhv-control-range">{(['min', 'max', 'step'] as const).map((field) => <label className="field" key={field}><span>{{ min: '最小值', max: '最大值', step: '步长' }[field]}</span><input type="number" step="any" readOnly={fixedPreset} aria-label={`${label}${{ min: '最小值', max: '最大值', step: '步长' }[field]}`} value={edit[field]} placeholder="未指定" onChange={(event) => setControlEdit({ [field]: event.target.value })} /></label>)}</div>}
        <div className="vwm-row"><small className="vwm-help">{fixedPreset ? '固定九档，按 0.1 递增。仅当前工作流生效。' : '仅保存到当前工作流，不改变节点默认值；未提供的范围保持未指定。'}</small><button type="button" className="vwm-text-button" disabled={!draft.fieldControls?.[id] && !outputControlEdits[id]} onClick={() => replaceOutputControl(binding)}>恢复云端定义</button></div>
      </div>
      <footer><p className="vwm-help">编辑加入当前草稿，点击“保存工作流”后生效。</p><button type="button" className="btn primary" onClick={() => setOutputControlKey(null)}>完成选项编辑</button></footer>
    </section></div>;
  }
  function bindingSelect(binding: RunningHubVideoInputBinding, label: string, onChangeBinding: (next: RunningHubVideoInputBinding) => void) {
    const found = nodeRows.some((node) => String(node.nodeId) === binding.nodeId && String(node.fieldName) === binding.inputName);
    const emptyLabel = nodeRows.length && !mappingChoices.length ? '当前范围无匹配字段，请调整搜索或切换高级' : '请选择实际节点字段';
    return <label className="field"><span>RunningHub 节点与字段</span><select aria-label={`${label}节点字段`} value={bindingKey(binding)} onChange={(event) => {
      const [nodeId, inputName] = JSON.parse(event.target.value) as [string, string]; onChangeBinding({ nodeId, inputName });
    }}><option value={found ? '["",""]' : bindingKey(binding)}>{found ? emptyLabel : binding.nodeId || binding.inputName ? `${binding.nodeId}.${binding.inputName} · 节点目录中不存在` : emptyLabel}</option>{mappingChoices.map((node) => <option key={bindingKey({ nodeId: node.nodeId, inputName: node.fieldName })} value={bindingKey({ nodeId: node.nodeId, inputName: node.fieldName })} disabled={typeof node.fieldValue !== 'string' || bindingKey({ nodeId: node.nodeId, inputName: node.fieldName }) === imageCountKey}>{node.nodeId}.{node.fieldName}{typeof node.description === 'string' && node.description ? ` · ${node.description}` : ''}{mappingRows.some((entry) => entry.nodeId === node.nodeId && entry.inputName === node.fieldName) ? ' · 已绑定' : ''}{typeof node.fieldValue !== 'string' ? ' · 非文本字段' : ''}{bindingKey({ nodeId: node.nodeId, inputName: node.fieldName }) === imageCountKey ? ' · 已用于每段实际图片数量' : ''}</option>)}</select></label>;
  }

  const runtimeRequest: Record<string, unknown> = parsed.request || {};
  const modal = <div className="vwm-backdrop rhv-backdrop" style={{ '--ui-font-scale': fontScale } as CSSProperties}>
    <section className={`vwm-dialog rhv-manager${tab === 'output' ? ' rhv-output-editor' : ''}`} ref={dialogRef} role="dialog" aria-modal="true" aria-label="RunningHub 云端视频工作流管理">
      <header className="vwm-header"><div><h2>RunningHub 云端视频工作流管理</h2><p>多份工作流独立保存 · 明确绑定提示词与参考图 · 这里只配置，不提交任务</p></div><button type="button" className="btn" aria-label="关闭 RunningHub 工作流管理" onClick={requestClose}>关闭</button></header>
      <div className="vwm-body">
        <aside className="vwm-library"><div className="vwm-library-heading"><h3>工作流库</h3><span>{config.workflows.length} 个</span></div><input aria-label="搜索 RunningHub 工作流" placeholder="搜索名称或云端 ID" value={search} onChange={(event) => { setSearch(event.target.value); setLibraryPage(0); }} />
          <div className="vwm-library-tools"><button type="button" className="btn small" onClick={() => create()}>新建</button><button type="button" className="btn small" onClick={() => { setImportOpen(true); clearNotice(); }}>导入 cURL / JSON</button><button type="button" className="btn small" onClick={() => create(true)}>教程结构样板</button></div>
          <div className="vwm-library-list">{filtered.slice(currentLibraryPage * 4, (currentLibraryPage + 1) * 4).map((workflow) => <button type="button" key={workflow.id} className={`vwm-library-item${draft?.id === workflow.id ? ' selected' : ''}`} aria-label={`编辑云端工作流 ${workflow.name}`} onClick={() => guardDiscard(() => { loadDraft(currentConfig().workflows.find((entry) => entry.id === workflow.id)); setTab('basic'); })}><strong>{workflow.name}</strong><span>{workflow.runKind === 'ai-app' ? 'AI 应用' : 'ComfyUI 工作流'} · {workflow.id === active?.id ? '当前使用' : isRunningHubVideoWorkflowReady(workflow) ? '可用' : '待配置'}</span></button>)}{!filtered.length && <p className="vwm-empty">尚无匹配工作流。导入 RunningHub 页面提供的 cURL 或请求 JSON 即可新增。</p>}</div>
          <Pager label="云端工作流库" total={filtered.length} page={currentLibraryPage} size={4} onChange={setLibraryPage} />
          <div className="vwm-current"><span>当前实际生效</span><strong>{active?.name || '尚未选择'}</strong><small>选中编辑 ≠ 设为当前</small></div>
        </aside>
        <main className="vwm-editor">{draft ? <>
          <div className="vwm-editor-heading"><div><strong title={draft.name}>{draft.name || '未命名工作流'}</strong><span className={`vwm-state${dirty ? ' pending' : ''}`}>{dirty ? '未保存' : '已保存'}</span></div><div className="vwm-editor-actions"><button type="button" className="btn small" onClick={copy}>复制</button><button type="button" className="btn small danger" disabled={!savedDraft} onClick={remove}>删除</button></div></div>
          <div className="vwm-tabs rhv-tabs" role="tablist" aria-label="云端工作流编辑区">{tabs.map(([value, label]) => <button type="button" role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} key={value} onClick={() => switchTab(value)}>{label}</button>)}</div>
          {(tab === 'mapping' || tab === 'output' || tab === 'parameters') && nodeTools()}
          {tab === 'output' && <div className="rhv-generation-tabs" role="tablist" aria-label="生成参数配置类别">{([['common', '常用参数'], ['lora', 'LoRA'], ['other', '其它']] as const).map(([value, label]) => <button type="button" role="tab" aria-selected={outputSection === value} className={outputSection === value ? 'active' : ''} key={value} onClick={() => { setOutputSection(value); clearNotice(); }}>{label}</button>)}</div>}
          <div className={`vwm-tab-panel${tab === 'output' ? ' rhv-output-panel' : ''}`} role="tabpanel" aria-label={tab === 'output' && outputSection !== 'common' ? outputSection === 'lora' ? 'LoRA 参数' : '其它参数' : tabs.find(([value]) => value === tab)?.[1]}>
            {tab === 'output' && outputSection !== 'common' && <RunningHubGenerationExtras key={`${draft.id}-${outputSection}`} section={outputSection} workflow={draft} nodeEdits={nodeEdits} onDefaultChange={(binding, text) => { setNodeEdits((current) => ({ ...current, [bindingKey(binding)]: text })); clearNotice(); }} onWorkflowChange={(next) => { setDraft(prepareWorkflowDraft(next)); clearNotice(); }} onReadNodes={() => { void readCloudNodes(); }} onImportNodes={() => openNodeDialog('json')} onManualNode={() => openNodeDialog('manual')} discovering={discovering} onDialogOpenChange={(open, close) => { extrasDialogClose.current = open ? close : null; }} />}
            {tab === 'output' && outputSection === 'common' && <>
              <div className="rhv-field-filters"><label className="field"><span>显示范围</span><select aria-label="生成参数字段范围" value={outputRange} onChange={(event) => setOutputRange(event.target.value === 'all' ? 'all' : 'common')}><option value="common">常用候选及已绑定</option><option value="all">全部字段（高级）</option></select></label><label className="field"><span>搜索节点（已绑定项保留）</span><input aria-label="搜索生成参数字段" value={outputSearch} onChange={(event) => setOutputSearch(event.target.value)} placeholder="节点 ID / 字段名 / 标题" /></label></div>
              <div className="rhv-output-fields">{outputField('duration')}{outputField('aspect_ratio')}{outputField('resolution')}{outputField('steps')}</div>
              {outputDraftIssue && <p className="vd-error">{outputDraftIssue}</p>}
              <p className="vwm-help">比例按云端字段提供的完整选项值提交；MP 使用单个像素选项；采样步数绑定真实字段。生成时留空使用原值；解除绑定保留请求字段。</p>
            </>}
            {tab === 'basic' && <><label className="field"><span>工作流名称（可直接重命名后保存）</span><input aria-label="RunningHub 工作流名称" value={draft.name} onChange={(event) => patchDraft({ name: event.target.value })} /></label><div className="rhv-two-fields"><label className="field"><span>云端调用类型</span><select aria-label="RunningHub 云端调用类型" value={draft.runKind} onChange={(event) => patchDraft({ runKind: event.target.value as RunningHubVideoWorkflow['runKind'] })}><option value="ai-app">AI 应用 · run/ai-app</option><option value="workflow">ComfyUI 工作流 · run/workflow</option></select></label><label className="field"><span>{draft.runKind === 'ai-app' ? 'AI 应用 ID' : '云端工作流 ID'}</span><input aria-label="RunningHub 云端 ID" value={draft.remoteId} inputMode="numeric" placeholder="从 RunningHub 调用地址中复制 ID" onChange={(event) => patchDraft({ remoteId: event.target.value })} /></label></div><label className="field"><span>最终视频输出节点 ID（可选）</span><input aria-label="RunningHub 视频输出节点 ID" value={draft.outputNodeId || ''} placeholder="留空：自动收集视频结果；多输出时可指定最终成片节点" onChange={(event) => patchDraft({ outputNodeId: event.target.value || undefined })} /></label><div className="vwm-info"><strong>只注入你明确绑定的输入</strong><p>当前视频提示词 → 提示词映射；选择的参考图 → 按顺序上传并填入图片槽。选择的参考音频 → 填入明确的音频槽，未选音频保留原值。工作流其余常量、LoRA 与自定义字段保持原值。</p><p>云端 ID 按文字保存，不会将 19 位 ID 转成浮点数。工作流须在 RunningHub 云端已存在，本软件不创建或上传本地 ComfyUI 画布。</p></div>{parsed.issues.length > 0 && <div className="rhv-issues"><strong>待配置项</strong><p>{parsed.issues.slice(0, 3).join('；')}</p></div>}</>}
            {tab === 'mapping' && <>
              <div className="vwm-section-tabs" role="tablist" aria-label="云端输入映射类别"><button type="button" role="tab" aria-selected={mappingTab === 'prompt'} className={mappingTab === 'prompt' ? 'active' : ''} onClick={() => { setMappingTab('prompt'); setMappingPage(0); setMappingRange('common'); setMappingSearch(''); }}>提示词输入 {draft.mapping.prompt.length}</button><button type="button" role="tab" aria-selected={mappingTab === 'images'} className={mappingTab === 'images' ? 'active' : ''} onClick={() => { setMappingTab('images'); setMappingPage(0); setMappingRange('common'); setMappingSearch(''); }}>参考图片槽 {draft.mapping.images.length}</button><button type="button" role="tab" aria-selected={mappingTab === 'audios'} className={mappingTab === 'audios' ? 'active' : ''} onClick={() => { setMappingTab('audios'); setMappingPage(0); setMappingRange('common'); setMappingSearch(''); }}>参考音频槽 {draft.mapping.audios?.length || 0}</button></div>
              {mappingTab === 'audios' ? <>
                <div className="vwm-info compact">音频文件输入按真实节点列出。每段视频单独选择声音、关联人物或旁白；未选音频的槽位保留工作流原值。</div>
                <div className="rhv-image-slot-grid rhv-audio-slot-grid" aria-label="全部云端音频槽">{(draft.mapping.audios || []).map((binding, index) => {
                  const node = nodeRows.find((entry) => entry.nodeId === binding.nodeId && entry.fieldName === binding.inputName);
                  return <div className="rhv-image-slot-card rhv-audio-slot-card" key={`${bindingKey(binding)}-${index}`}>
                    <div className="rhv-image-slot-heading"><strong>音频槽 {index + 1}</strong><code aria-label={`云端音频槽 ${index + 1} 节点字段`} title={`${binding.nodeId}.${binding.inputName}`}>{binding.nodeId}.{binding.inputName}</code></div>
                    <label className="field"><span>槽位名称（可选）</span><input aria-label={`云端音频槽 ${index + 1} 名称`} value={binding.label || ''} placeholder={`音频槽 ${index + 1}`} onChange={(event) => patchMapping({ audios: (draft.mapping.audios || []).map((item, position) => position === index ? { ...item, label: event.target.value } : item) })} /></label>
                    <small className="rhv-slot-hint">声音用途及人物在当前分段中选择</small>
                    <small className="rhv-audio-original" title={node ? valueText(node.fieldValue) : undefined}>未选音频：{node ? `保留原值 ${valueText(node.fieldValue) || '（空字符串）'}` : '保留原请求字段'}</small>
                    {!node && <><small className="rhv-slot-warning">节点目录中缺失，请重新读取节点核对。</small><button type="button" className="btn small" aria-label={`移除失效云端音频槽 ${index + 1}`} onClick={() => patchMapping({ audios: (draft.mapping.audios || []).filter((_, position) => position !== index) })}>移除失效映射</button></>}
                  </div>;
                })}</div>
                {!draft.mapping.audios?.length && <div className="vwm-empty">尚未找到可上传的音频输入。读取云端节点或导入 API 节点 JSON 后自动识别；自定义字段可在“手动添加字段”中明确选择音频输入。</div>}
                <p className="vwm-help">共 {draft.mapping.audios?.length || 0} 个音频槽。这里只配置节点；声音属于谁由分段选择明确指定，槽位数量不代表云端支持多人独立配音。点击“保存工作流”后生效。</p>
              </> : mappingTab === 'images' ? <>
                <div className="vwm-info compact">每段视频的图片数量和用途可在“生成视频 → 选择参考图”中单独设置。{imageProtocol?.verifiedProfile && imageCount ? '当前工作流按实际图片数量运行，未使用的图片槽会按云端支持的方式留空。' : '能否留空及如何跳过未使用图片，以云端工作流支持的规则为准。'}</div>
                <div className="vwm-mapping-item">
                  <label className="field"><span>图片数量字段（每个工作流配置一次）</span><select aria-label="RunningHub 图片数量字段" value={draft.mapping.imageCount === null ? 'none' : draft.mapping.imageCount ? bindingKey(draft.mapping.imageCount) : 'auto'} onChange={(event) => updateImageCountBinding(event.target.value)}>
                    <option value="auto">自动识别（仅已核实的云端应用）</option>
                    <option value="none">不绑定（保留数量字段原值）</option>
                    {draft.mapping.imageCount && !imageCountCandidates.some((node) => bindingKey({ nodeId: node.nodeId, inputName: node.fieldName }) === bindingKey(draft.mapping.imageCount!)) && <option value={bindingKey(draft.mapping.imageCount)} disabled>{draft.mapping.imageCount.nodeId}.{draft.mapping.imageCount.inputName} · 缺失或不是整数字段</option>}
                    {imageCountCandidates.map((node) => {
                      const binding = { nodeId: node.nodeId, inputName: node.fieldName };
                      const conflict = runningHubImageCountConflict(draft, binding);
                      return <option key={bindingKey(binding)} value={bindingKey(binding)} disabled={Boolean(conflict)}>{node.nodeId}.{node.fieldName}{typeof node.description === 'string' && node.description ? ` · ${node.description}` : ''}{conflict ? ` · 已用于${conflict}` : ''}</option>;
                    })}
                  </select></label>
                  {imageCount ? <p className="vwm-help">每段按实际选图数量自动填写（含衔接尾帧）。已绑定：<code>{imageCount.nodeId}.{imageCount.inputName}</code>{imageProtocol?.imageCountSource === 'verified-app' ? ' · 已核实的应用字段' : ''}。无需逐段手填数量。</p>
                    : <p className="vwm-help">{draft.mapping.imageCount === null ? '当前不自动填写图片数量，数量字段保留原值。' : '尚未识别到已核实的图片数量字段；如云端提供“使用几张图”等输入，请在此选择对应字段。'} 仅接受非负整数或整数字符串；选择字段不会让云端自动获得可选图片能力。</p>}
                </div>
                <div className="rhv-image-slot-grid" aria-label="全部云端图片槽">{draft.mapping.images.map((binding, index) => {
                  const node = nodeRows.find((entry) => entry.nodeId === binding.nodeId && entry.fieldName === binding.inputName);
                  return <div className="rhv-image-slot-card" key={`${bindingKey(binding)}-${index}`}>
                    <div className="rhv-image-slot-heading"><strong>图片槽 {index + 1}</strong><code aria-label={`云端图片槽 ${index + 1} 节点字段`} title={`${binding.nodeId}.${binding.inputName}`}>{binding.nodeId}.{binding.inputName}</code></div>
                    <small className="rhv-slot-hint">用途在生成视频时按当前分段选择</small>
                    {!node && <><small className="rhv-slot-warning">节点目录中缺失，请重新读取节点核对。</small><button type="button" className="btn small" aria-label={`移除失效云端图片槽 ${index + 1}`} onClick={() => patchMapping({ images: draft.mapping.images.filter((_, position) => position !== index) })}>移除失效映射</button></>}
                  </div>;
                })}</div>
                {!draft.mapping.images.length && <div className="vwm-empty">尚未找到图片输入槽。文生视频可不选图；图生视频请先“读取云端节点”或导入节点 JSON，识别后会全部显示。自定义字段可在“手动添加字段”中明确标为图片输入。</div>}
                <p className="vwm-help">共 {draft.mapping.images.length} 个图片槽。此处维护槽位顺序、节点字段及图片数量绑定；每段选图独立保存。点击“保存工作流”后生效；必填图片和可选空槽须符合云端工作流规则。</p>
              </> : <>
                <div className="vwm-info compact">{mappingRange === 'all' ? '高级列表包含工作流内部配置，请核对字段用途；不自动绑定提示词，提示词映射需要文本字段。' : '按字段名与标题显示提示词候选，排除常见图片和技术参数。仅辅助查找，选择后才绑定，不自动判断用途。'}</div>
                {fieldFilters(true)}
                <div className="vwm-mapping-list">{draft.mapping.prompt.slice(currentMappingPage * pageSize, (currentMappingPage + 1) * pageSize).map((binding, localIndex) => {
                  const index = currentMappingPage * pageSize + localIndex; const label = `云端提示词 ${index + 1} `;
                  return <div className="vwm-mapping-item" key={`prompt-${index}`}><div className="vwm-row"><strong>{label}</strong><button type="button" className="btn small" aria-label={`移除${label.trim()}`} onClick={() => patchMapping({ prompt: draft.mapping.prompt.filter((_, position) => position !== index) })}>移除</button></div>{bindingSelect(binding, label, (next) => patchMapping({ prompt: draft.mapping.prompt.map((item, position) => position === index ? { ...item, ...next } : item) }))}</div>;
                })}{!draft.mapping.prompt.length && <div className="vwm-empty">添加需要替换为当前视频提示词的真实节点字段。</div>}</div>
                <div className="vwm-collection-footer"><button type="button" className="btn small" onClick={() => { patchMapping({ prompt: [...draft.mapping.prompt, { nodeId: '', inputName: '' }] }); setMappingPage(Math.floor(draft.mapping.prompt.length / pageSize)); }}>添加云端提示词输入</button><Pager label="云端输入映射" total={draft.mapping.prompt.length} page={currentMappingPage} size={pageSize} onChange={setMappingPage} /></div>
                <p className="vwm-help">{nodeRows.length && !mappingCommon.length ? '未识别到常用候选，可切换“全部字段（高级）”查找自定义输入。' : '常用候选仅辅助查找；自定义输入可切换“全部字段（高级）”。'} 筛选不会修改请求。</p>
              </>}
            </>}
            {tab === 'parameters' && <>{fieldFilters(false)}<div className="vwm-parameter-list">{filteredNodes.slice(currentParameterPage * pageSize, (currentParameterPage + 1) * pageSize).map((node) => {
              const binding = { nodeId: String(node.nodeId), inputName: String(node.fieldName) }; const key = bindingKey(binding);
              const promptIndex = draft.mapping.prompt.findIndex((entry) => bindingKey(entry) === key); const imageIndex = draft.mapping.images.findIndex((entry) => bindingKey(entry) === key);
              const parameterName = Object.entries(draft.mapping.parameters || {}).find(([, entry]) => bindingKey(entry) === key)?.[0] || '';
              const countDynamic = key === imageCountKey;
              const audioIndex = (draft.mapping.audios || []).findIndex((entry) => bindingKey(entry) === key);
              const dynamic = countDynamic || promptIndex >= 0 || imageIndex >= 0 || audioIndex >= 0;
              const inRequest = parsed.request?.nodeInfoList.some((entry) => entry?.nodeId === node.nodeId && entry.fieldName === node.fieldName);
              const unsafeInteger = typeof node.fieldValue === 'number' && Number.isInteger(node.fieldValue) && !Number.isSafeInteger(node.fieldValue);
              const scalar = ['string', 'number', 'boolean'].includes(typeof node.fieldValue) && !unsafeInteger;
              return <div className="vwm-parameter-item" key={key}><div className="vwm-row"><strong>{node.nodeId}.{node.fieldName}</strong><span className="vwm-value-type">{countDynamic ? '调用时填实际图片数量' : promptIndex >= 0 ? '调用时填视频提示词' : imageIndex >= 0 ? `调用时填第 ${imageIndex + 1} 张图片` : audioIndex >= 0 ? `选择后填音频槽 ${audioIndex + 1}，未选保留原值` : parameterName ? `明确覆盖参数：${parameterName}` : inRequest ? '保留请求原值' : '云端默认 · 尚未覆盖'}</span></div><div className="rhv-two-fields"><label className="field"><span>字段默认值 · {typeof node.fieldValue}</span>{typeof node.fieldValue === 'boolean' ? <select aria-label={`云端字段 ${node.nodeId}.${node.fieldName} 默认值`} disabled={dynamic} value={nodeEdits[key] ?? String(node.fieldValue)} onChange={(event) => { setNodeEdits({ ...nodeEdits, [key]: event.target.value }); clearNotice(); }}><option value="true">true</option><option value="false">false</option></select> : <input aria-label={`云端字段 ${node.nodeId}.${node.fieldName} 默认值`} disabled={dynamic || !scalar} value={dynamic ? countDynamic ? '每段实际图片数量（含衔接尾帧）' : promptIndex >= 0 ? '使用当前视频提示词' : audioIndex >= 0 ? `音频槽 ${audioIndex + 1} · 未选保留原值` : `上传第 ${imageIndex + 1} 张参考图` : nodeEdits[key] ?? valueText(node.fieldValue)} title={!scalar ? '复杂值请在请求 JSON 中编辑' : undefined} onChange={(event) => { setNodeEdits({ ...nodeEdits, [key]: event.target.value }); clearNotice(); }} />}</label><label className="field"><span>可覆盖参数名（留空为常量）</span><input aria-label={`云端字段 ${node.nodeId}.${node.fieldName} 参数名`} disabled={dynamic} value={parameterName} placeholder="例如 duration / seed / width" onChange={(event) => updateParameterBinding(binding, event.target.value)} /></label></div>{typeof node.description === 'string' && node.description && <p className="vwm-help">{node.description}</p>}{!inRequest && !dynamic && !Object.prototype.hasOwnProperty.call(nodeEdits, key) && <button type="button" className="vwm-text-button" onClick={() => useCatalogDefault(node)}>将此默认值加入请求</button>}{Object.prototype.hasOwnProperty.call(nodeEdits, key) && <button type="button" className="vwm-text-button" onClick={() => { const next = { ...nodeEdits }; delete next[key]; setNodeEdits(next); }}>撤销这个默认值编辑</button>}</div>;
            })}{!filteredNodes.length && <p className="vwm-empty">{nodeRows.length ? '当前范围未找到匹配字段，请调整搜索词或切换“全部字段（高级）”。' : '当前没有节点资料。点击上方“读取云端节点”，或导入工作流 API 格式 JSON。'}</p>}</div><Pager label="云端节点参数" total={filteredNodes.length} page={currentParameterPage} size={pageSize} onChange={setParameterPage} /><p className="vwm-help">目录字段默认不发送；编辑默认值或绑定参数时才加入请求。未编辑的云端字段不覆盖。</p></>}
            {tab === 'runtime' && <>
              <div className="vwm-info compact rhv-runtime-help"><strong>教程的 6 项是接口外层参数，不是 6 个节点</strong><p>nodeInfoList 由“输入映射 / 节点参数”配置；实例、队列、保留时长和回调在下方设置。addMetadata（元数据开关）保留原值，可在“请求 JSON”编辑。</p></div>
              <div className="rhv-two-fields">
                <label className="field"><span>运行实例</span><select aria-label="RunningHub 运行实例" disabled={!parsed.request} value={typeof runtimeRequest.instanceType === 'string' ? runtimeRequest.instanceType : 'default'} onChange={(event) => runtime('instanceType', event.target.value)}><option value="default">default · 24G 显存</option><option value="plus">plus · 48G 显存</option><option value="ultra">ultra · 84G 显存</option></select></label>
                <label className="field"><span>个人独占队列</span><select aria-label="RunningHub 个人队列" disabled={!parsed.request} value={runtimeRequest.usePersonalQueue === true || runtimeRequest.usePersonalQueue === 'true' ? 'true' : 'false'} onChange={(event) => runtime('usePersonalQueue', event.target.value === 'true')}><option value="false">不使用</option><option value="true">使用个人独占队列</option></select></label>
              </div>
              <div className="rhv-cost-note"><strong>实例保留会额外计费，默认不启用</strong><p>retainSeconds 仅企业共享 API Key 生效。保留时长为 10–180 秒；留空即不请求实例保留。更大显存或个人队列的资格、费用以你的 RunningHub 账号为准。</p>
                <label className="field"><span>实例保留秒数（可选，留空关闭）</span><input type="number" min="10" max="180" step="1" aria-label="RunningHub 实例保留秒数" disabled={!parsed.request} value={retainSecondsEdit ?? (typeof runtimeRequest.retainSeconds === 'number' || typeof runtimeRequest.retainSeconds === 'string' ? runtimeRequest.retainSeconds : '')} placeholder="不启用" onChange={(event) => { setRetainSecondsEdit(event.target.value); clearNotice(); }} /></label>
              </div>
              <label className="field"><span>Webhook 回调地址（可选）</span><input type="url" aria-label="RunningHub Webhook 回调地址" disabled={!parsed.request} value={typeof runtimeRequest.webhookUrl === 'string' ? runtimeRequest.webhookUrl : ''} placeholder="默认不设置；仅填写你自己接收结果的 HTTPS 地址" onChange={(event) => runtime('webhookUrl', event.target.value || undefined)} /></label>
              <p className="vwm-help">只会发送你明确保存的回调地址。软件自身通过任务查询取得结果，不需要 Webhook，也不会自动开启实例保留。</p>
            </>}
            {tab === 'json' && <><p className="vwm-help">RunningHub 请求体（包含 nodeInfoList），不是本地 ComfyUI 的 API 节点图或普通画布。图片和音频文件输入会补齐为草稿槽位；既有槽位顺序和映射保留，用途及人物在生成视频时按分段设置。</p><label className="field vwm-json-field"><span>RunningHub 请求 JSON 编辑稿</span><textarea aria-label="RunningHub 请求 JSON 编辑稿" spellCheck={false} value={draft.requestTemplate} onChange={(event) => patchDraft({ requestTemplate: event.target.value })} /></label><div className="vwm-json-actions"><button type="button" className="btn small" disabled={dirty || !savedDraft} onClick={exportWorkflow}>导出无密钥配置</button><button type="button" className="btn small" onClick={() => { setImportOpen(true); clearNotice(); }}>导入为另一个工作流</button></div><p className="vwm-help">密钥只填在云端连接设置中。导出包含工作流 ID、请求和自定义映射；请勿在节点文本或 Webhook URL 中写入密码。</p></>}
          </div>
        </> : <div className="vwm-editor-empty"><h3>新增 RunningHub 云端工作流</h3><p>粘贴 RunningHub 应用/工作流页面提供的 cURL，或导入 nodeInfoList 请求 JSON。不同工作流分开保存，以后切换即可复用。</p><button type="button" className="btn primary" onClick={() => { setImportOpen(true); clearNotice(); }}>导入 cURL / JSON</button><button type="button" className="btn" onClick={() => create(true)}>查看教程结构样板</button></div>}</main>
      </div>
      <div className={`vwm-notice${error ? ' error' : ''}`} role={error ? 'alert' : 'status'} title={error || message || undefined}>{error || message || (dirty ? '有未保存的编辑，切换或关闭会询问是否放弃。' : '读取节点仅查询结构；这里不会上传素材或提交生成任务。')}</div>
      <footer className="vwm-footer"><span>{draft ? `${parsed.issues.length ? '待配置' : '配置可用'} · ${active?.id === draft.id ? '当前工作流' : '仅选中编辑'}` : '导入新增，不覆盖已有配置'}</span><div><button type="button" className="btn" disabled={!draft || !savedDraft || dirty || Boolean(parsed.issues.length) || active?.id === draft?.id} onClick={activate}>设为当前</button><button type="button" className="btn primary" disabled={!draft || (!dirty && Boolean(savedDraft))} onClick={save}>保存工作流</button><button type="button" className="btn" onClick={requestClose}>完成</button></div></footer>
      <input ref={fileRef} type="file" hidden accept=".json,.txt,.curl,application/json,text/plain" aria-label="导入 RunningHub 配置文件" onChange={(event) => { void importFile(event); }} />
      <input ref={nodeFileRef} type="file" hidden accept=".json,.txt,application/json,text/plain" aria-label="导入 RunningHub 节点文件" onChange={(event) => { void importNodeFile(event); }} />
      {outputControlDialog()}
      {nodeDialog && <div className="rhv-import-backdrop"><section className={`rhv-import-dialog rhv-node-dialog${nodeDialog === 'manual' ? ' manual' : ''}`} role="dialog" aria-modal="true" aria-label={nodeDialog === 'json' ? '导入 RunningHub 节点 JSON' : '手动添加 RunningHub 字段'}>
        <header><h3>{nodeDialog === 'json' ? '导入节点 JSON' : '手动添加字段'}</h3><button type="button" className="btn small" onClick={closeNodeDialog}>关闭节点编辑</button></header>
        <p className="vwm-help">{nodeDialog === 'json' ? '导入 ComfyUI API 格式（inputs / class_type）、RunningHub 节点列表或读取结构响应。仅补充当前工作流的候选字段，不上传画布、不提交生成。普通画布的控件顺序不能代替真实字段名。' : '请从云端工作流中复制真实节点 ID 和字段名。名称可以相同，节点 ID 不能用显示标题代替。提示词和素材上传文件名使用文本类型。'}</p>
        {nodeDialog === 'json' ? <label className="field rhv-import-source"><span>节点 JSON</span><textarea aria-label="RunningHub 节点 JSON" spellCheck={false} value={nodeSource} onChange={(event) => setNodeSource(event.target.value)} placeholder={'{"12":{"class_type":"CLIPTextEncode","inputs":{"text":"提示词"}}}\n或 {"nodeInfoList":[{"nodeId":"12","fieldName":"text","fieldValue":""}]}'} /></label> : <div className="rhv-manual-fields">
          <div className="rhv-two-fields"><label className="field"><span>节点 ID（nodeId）</span><input aria-label="手动节点 ID" value={manualNode.nodeId} onChange={(event) => setManualNode({ ...manualNode, nodeId: event.target.value })} placeholder="复制实际节点 ID" /></label><label className="field"><span>字段名（fieldName）</span><input aria-label="手动节点字段名" value={manualNode.fieldName} onChange={(event) => setManualNode({ ...manualNode, fieldName: event.target.value })} placeholder="例如 text / image / audio / seed" /></label></div>
          <div className="rhv-two-fields"><label className="field"><span>字段类型</span><select aria-label="手动节点字段类型" value={manualNode.type} onChange={(event) => setManualNode({ ...manualNode, type: event.target.value, value: event.target.value === 'boolean' ? 'false' : manualNode.value })}><option value="string">文本 string</option><option value="image">图片输入（高级自定义）</option><option value="audio">音频输入（高级自定义）</option><option value="number">数字 number</option><option value="boolean">开关 boolean</option></select></label><label className="field"><span>云端默认值（文本可留空）</span>{manualNode.type === 'boolean' ? <select aria-label="手动节点默认值" value={manualNode.value} onChange={(event) => setManualNode({ ...manualNode, value: event.target.value })}><option value="false">false</option><option value="true">true</option></select> : <input aria-label="手动节点默认值" value={manualNode.value} onChange={(event) => setManualNode({ ...manualNode, value: event.target.value })} />}</label></div>
          <p className="vwm-help">图片和音频文件字段自动列为素材槽。自定义名称无法识别时可明确选择“图片输入”或“音频输入”；字段必须接受上传文件名，不能是节点连线或音频处理 tensor。</p>
        </div>}
        <div className="rhv-import-feedback" role={error ? 'alert' : 'status'}>{error || '图片和音频文件字段会补齐为编辑稿槽位；其他字段只补目录，既有槽位顺序与参数值保留，用途及人物在生成视频时按分段设置。'}</div>
        <footer><div>{nodeDialog === 'json' && <button type="button" className="btn" disabled={nodeFileBusy} onClick={() => nodeFileRef.current?.click()}>{nodeFileBusy ? '读取文件中…' : '选择节点文件'}</button>}</div><div><button type="button" className="btn" onClick={closeNodeDialog}>取消</button><button type="button" className="btn primary" disabled={nodeFileBusy || (nodeDialog === 'json' ? !nodeSource.trim() : !manualNode.nodeId.trim() || !manualNode.fieldName.trim())} onClick={() => nodeDialog === 'json' ? acceptNodeSource(nodeSource) : addManualNode()}>{nodeDialog === 'json' ? '加入节点目录' : '添加字段'}</button></div></footer>
      </section></div>}
      {importOpen && <div className="rhv-import-backdrop"><section className="rhv-import-dialog" role="dialog" aria-modal="true" aria-label="导入 RunningHub cURL 或 JSON"><header><h3>导入 RunningHub cURL / JSON</h3><button type="button" className="btn small" onClick={cancelImport}>关闭导入</button></header><p className="vwm-help">只读取文本，不会执行 cURL。连接密钥不从教程导入；nodeInfoList 以外的本地 ComfyUI 图不会被猜测转换。</p><label className="field"><span>新工作流名称（可选）</span><input aria-label="导入的 RunningHub 工作流名称" value={importName} onChange={(event) => setImportName(event.target.value)} placeholder="例如 长剧情图生视频" /></label><label className="field rhv-import-source"><span>粘贴 RunningHub 请求 cURL、请求 JSON 或本软件导出的配置</span><textarea aria-label="RunningHub 导入文本" spellCheck={false} value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={'curl --request POST \'https://www.runninghub.ai/openapi/v2/run/ai-app/你的应用ID\' ...\n或 { "nodeInfoList": [...] }'} /></label><div className="rhv-import-feedback" role={error ? 'alert' : 'status'}>{error || '导入仅新增配置，不覆盖已有工作流，也不自动设为当前。'}</div><footer><button type="button" className="btn" disabled={importing} onClick={() => fileRef.current?.click()}>{importing ? '读取文件中…' : '选择文件'}</button><div><button type="button" className="btn" onClick={cancelImport}>取消</button><button type="button" className="btn primary" disabled={!importText.trim() || importing} onClick={() => acceptImport(importText, importName)}>导入为新工作流</button></div></footer></section></div>}
      {confirmation && <div className="vwm-confirm-backdrop"><section className="vwm-confirm" role="alertdialog" aria-modal="true" aria-label={confirmation.title}><h3>{confirmation.title}</h3><p>{confirmation.body}</p><div><button type="button" className="btn" onClick={() => setConfirmation(undefined)}>取消</button><button type="button" className={`btn ${confirmation.danger ? 'danger' : 'primary'}`} onClick={() => { const action = confirmation.action; setConfirmation(undefined); action(); }}>{confirmation.actionLabel}</button></div></section></div>}
    </section>
  </div>;
  return typeof document === 'undefined' ? modal : createPortal(modal, document.body);
}
