import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  addRunningHubLoraSlot, addRunningHubOtherField, listRunningHubLoraSlots, listRunningHubOtherFields,
  removeRunningHubLoraSlot, removeRunningHubOtherField,
} from '../runningHubGenerationExtras';
import { resolveRunningHubVideoImageProtocol } from '../runningHubImageProtocol';
import { isRunningHubVideoSecretField, listRunningHubVideoNodes, resolveRunningHubVideoFieldControl } from '../runningHubVideoNodes';
import { setRunningHubVideoFieldControl } from '../runningHubVideoOutput';
import type { RunningHubLoraSlot, RunningHubVideoFieldControl, RunningHubVideoInputBinding, RunningHubVideoNodeInfo, RunningHubVideoWorkflow } from '../runningHubVideoTypes';

export interface RunningHubGenerationExtrasProps {
  section: 'lora' | 'other';
  workflow: RunningHubVideoWorkflow;
  nodeEdits: Record<string, string>;
  onDefaultChange: (binding: RunningHubVideoInputBinding, text: string) => void;
  onWorkflowChange: (next: RunningHubVideoWorkflow) => void;
  onReadNodes: () => void;
  onImportNodes: () => void;
  onManualNode: () => void;
  discovering: boolean;
  onDialogOpenChange?: (open: boolean, close: () => void) => void;
}

const bindingKey = (binding: RunningHubVideoInputBinding) => JSON.stringify([binding.nodeId, binding.inputName]);
const nodeBinding = (node: RunningHubVideoNodeInfo): RunningHubVideoInputBinding => ({ nodeId: node.nodeId, inputName: node.fieldName });
const bindingText = (binding: RunningHubVideoInputBinding) => `${binding.nodeId}.${binding.inputName}`;
const scalar = (value: unknown) => typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
const numberText = (value: number | undefined) => value === undefined ? '' : String(value);
const optionsFromText = (text: string) => [...new Set(text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean))];
const customOption = '__rhv_custom_value__';
const commonKeys = new Set(['duration', 'aspect_ratio', 'resolution', 'steps', 'width', 'height']);
interface ControlEdit {
  binding: RunningHubVideoInputBinding;
  title: string;
  kind: RunningHubVideoFieldControl['kind'];
  options: string;
  min: string;
  max: string;
  step: string;
}
type Dialog = { kind: 'lora'; model: string; strength: string; clipStrength: string; label: string; previousModel?: RunningHubVideoInputBinding }
  | { kind: 'other'; field: string }
  | { kind: 'control'; edit: ControlEdit };

/** These panels only edit exposed request fields; they never create a cloud node. */
export function RunningHubGenerationExtras({ section, workflow, nodeEdits, onDefaultChange, onWorkflowChange,
  onReadNodes, onImportNodes, onManualNode, discovering, onDialogOpenChange }: RunningHubGenerationExtrasProps) {
  const [page, setPage] = useState(0);
  const [capacity, setCapacity] = useState(4);
  const [columns, setColumns] = useState(2);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [customValues, setCustomValues] = useState<Record<string, boolean>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const dialogNotifyRef = useRef(onDialogOpenChange);
  dialogNotifyRef.current = onDialogOpenChange;
  const nodes = useMemo(() => listRunningHubVideoNodes(workflow.requestTemplate, workflow.nodeCatalog), [workflow.requestTemplate, workflow.nodeCatalog]);
  const slots = listRunningHubLoraSlots(workflow);
  const others = listRunningHubOtherFields(workflow);
  const imageCount = resolveRunningHubVideoImageProtocol(workflow).imageCount;
  const reserved = new Set([...workflow.mapping.prompt, ...workflow.mapping.images,
    ...(imageCount ? [imageCount] : []), ...Object.entries(workflow.mapping.parameters || {})
      .filter(([name]) => commonKeys.has(name)).map(([, binding]) => binding)].map(bindingKey));
  const counts = new Map<string, number>();
  nodes.forEach((node) => counts.set(bindingKey(nodeBinding(node)), (counts.get(bindingKey(nodeBinding(node))) || 0) + 1));
  const available = nodes.filter((node) => scalar(node.fieldValue) && counts.get(bindingKey(nodeBinding(node))) === 1
    && !isRunningHubVideoSecretField(node.fieldName) && !reserved.has(bindingKey(nodeBinding(node))));
  const otherCandidates = available.filter((node) => {
    if (others.some((binding) => bindingKey(binding) === bindingKey(nodeBinding(node)))) return false;
    try { addRunningHubOtherField(workflow, nodeBinding(node)); return true; } catch { return false; }
  });
  const total = section === 'lora' ? slots.length : others.length;
  const pages = Math.max(1, Math.ceil(total / capacity));
  const currentPage = Math.min(page, pages - 1);
  const visibleSlots = slots.slice(currentPage * capacity, (currentPage + 1) * capacity);
  const visibleOthers = others.slice(currentPage * capacity, (currentPage + 1) * capacity);
  const hasExtraInput = Object.values(customValues).some(Boolean);
  const hasClipStrength = slots.some((slot) => slot.clipStrength);
  const matching = (node: RunningHubVideoNodeInfo) => !search.trim()
    || `${node.nodeId}.${node.fieldName} ${typeof node.description === 'string' ? node.description : ''}`.toLowerCase().includes(search.trim().toLowerCase());
  const closeDialog = () => { setDialog(null); setError(''); setSearch(''); };

  useEffect(() => { setPage(0); setCustomValues({}); closeDialog(); }, [section, workflow.id]);
  useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const nextColumns = width < 420 ? 1 : 2;
      const rows = height < (hasExtraInput || hasClipStrength ? 375 : 325) ? 1 : 2;
      setColumns(nextColumns);
      setCapacity(nextColumns * rows);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasExtraInput, hasClipStrength]);
  const dialogOpen = dialog !== null;
  useEffect(() => {
    dialogNotifyRef.current?.(dialogOpen, closeDialog);
    if (!dialogOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    modalRef.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    return () => { dialogNotifyRef.current?.(false, closeDialog); if (previous?.isConnected) previous.focus(); };
  }, [dialogOpen]);

  const beginDialog = (next: Dialog) => { setSearch(''); setError(''); setDialog(next); };
  const openLora = (slot?: RunningHubLoraSlot) => beginDialog({ kind: 'lora', model: slot ? bindingKey(slot.model) : '',
    strength: slot?.strength ? bindingKey(slot.strength) : '', clipStrength: slot?.clipStrength ? bindingKey(slot.clipStrength) : '', label: slot?.label || '',
    ...(slot ? { previousModel: slot.model } : {}) });
  const openControl = (binding: RunningHubVideoInputBinding, title: string) => {
    const resolved = resolveRunningHubVideoFieldControl(workflow, binding);
    const control = resolved?.control || { kind: 'text' as const };
    beginDialog({ kind: 'control', edit: { binding, title, kind: control.kind, options: control.options?.join('\n') || '',
      min: numberText(control.min), max: numberText(control.max), step: numberText(control.step) } });
  };
  const nodeFor = (binding: RunningHubVideoInputBinding) => nodes.find((node) => node.nodeId === binding.nodeId && node.fieldName === binding.inputName);
  const chosenBinding = (value: string) => {
    const selected = available.find((node) => bindingKey(nodeBinding(node)) === value);
    if (!selected) throw new Error('请选择实际节点字段；缺少字段时先读取云端节点或手动添加。');
    return nodeBinding(selected);
  };
  function applyDialog() {
    if (!dialog) return;
    try {
      if (dialog.kind === 'lora') {
        const model = chosenBinding(dialog.model);
        const next = dialog.previousModel && bindingKey(dialog.previousModel) !== bindingKey(model)
          ? removeRunningHubLoraSlot(workflow, dialog.previousModel) : workflow;
        onWorkflowChange(addRunningHubLoraSlot(next, { model,
          ...(dialog.strength ? { strength: chosenBinding(dialog.strength) } : {}),
          ...(dialog.clipStrength ? { clipStrength: chosenBinding(dialog.clipStrength) } : {}), ...(dialog.label.trim() ? { label: dialog.label.trim() } : {}) }));
      } else if (dialog.kind === 'other') {
        onWorkflowChange(addRunningHubOtherField(workflow, chosenBinding(dialog.field)));
      } else {
        const { edit } = dialog;
        const existing = resolveRunningHubVideoFieldControl(workflow, edit.binding)?.control;
        const control: RunningHubVideoFieldControl = { kind: edit.kind, ...(existing?.unit ? { unit: existing.unit } : {}) };
        if (edit.kind === 'select') {
          control.options = optionsFromText(edit.options);
          if (!control.options.length) throw new Error('请按每行一个填写实际选项值，或改用文本输入。');
          if (existing?.optionLabels) control.optionLabels = existing.optionLabels;
          if (existing?.optionLabelAspectRatio) control.optionLabelAspectRatio = existing.optionLabelAspectRatio;
        }
        if (edit.kind !== 'text') {
          for (const key of ['min', 'max', 'step'] as const) {
            if (!edit[key].trim()) continue;
            const value = Number(edit[key]);
            if (!Number.isFinite(value) || key === 'step' && value <= 0) throw new Error('范围请输入有效数字，步长须大于 0；这些数据只用于提示。');
            control[key] = value;
          }
          if (control.min !== undefined && control.max !== undefined && control.min > control.max) throw new Error('最小值不能大于最大值。');
        }
        onWorkflowChange(setRunningHubVideoFieldControl(workflow, edit.binding, control));
      }
      closeDialog();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '配置未完成，请检查实际节点字段。'); }
  }

  function valueEditor(binding: RunningHubVideoInputBinding, title: string, forceNumber = false) {
    const node = nodeFor(binding);
    const resolved = resolveRunningHubVideoFieldControl(workflow, binding);
    if (!node || !resolved) return <p className="vwm-help">未找到实际字段 {bindingText(binding)}，请读取节点后重新指定位置。</p>;
    const key = bindingKey(binding);
    const value = nodeEdits[key] ?? String(resolved.defaultValue);
    const control = resolved.control;
    const options = control.kind === 'select' ? control.options || [] : [];
    const custom = Boolean(customValues[key]);
    const numeric = forceNumber || control.kind === 'number';
    const rangeNote = numeric && (control.min !== undefined || control.max !== undefined)
      ? `云端范围提示：${control.min ?? '不限'} ～ ${control.max ?? '不限'}` : '';
    const outside = numeric && value.trim() && Number.isFinite(Number(value))
      && (control.min !== undefined && Number(value) < control.min || control.max !== undefined && Number(value) > control.max);
    return <div className="rhv-extras-value">
      <label className="field"><span>{title}</span>{typeof resolved.defaultValue === 'boolean' ?
        <select aria-label={`${title} ${bindingText(binding)}`} value={value} onChange={(event) => onDefaultChange(binding, event.target.value)}><option value="true">true</option><option value="false">false</option></select>
        : options.length > 0 ? <select aria-label={`${title} ${bindingText(binding)}`} value={custom ? customOption : value} onChange={(event) => {
          const next = event.target.value;
          setCustomValues((previous) => ({ ...previous, [key]: next === customOption }));
          if (next !== customOption) onDefaultChange(binding, next);
        }}>
          {!options.includes(value) && <option value={value}>当前值：{value || '空'}</option>}
          {options.map((option) => <option key={option} value={option}>{option}{control.optionLabels?.[option] ? `（${control.optionLabels[option]}）` : ''}</option>)}
          <option value={customOption}>输入其他值…</option>
        </select> : <input aria-label={`${title} ${bindingText(binding)}`} type={numeric ? 'number' : 'text'} inputMode={numeric ? 'decimal' : 'text'} step={numeric ? control.step ?? 'any' : undefined}
          value={value} onChange={(event) => onDefaultChange(binding, event.target.value)} placeholder={forceNumber ? '填写实际强度值' : '填写云端实际文件名或值'} />}</label>
      {options.length > 0 && custom && <input aria-label={`${title}自定义值 ${bindingText(binding)}`} value={value} onChange={(event) => onDefaultChange(binding, event.target.value)} placeholder="填写云端支持的实际值" />}
      {rangeNote && <span className={outside ? 'rhv-extras-range warning' : 'rhv-extras-range'}>{rangeNote}{outside ? '（当前值超出，仅提醒）' : ''}</span>}
    </div>;
  }

  function fieldSelect(label: string, selected: string, candidates: RunningHubVideoNodeInfo[], onChange: (value: string) => void, optional = false) {
    const shown = candidates.filter((node) => matching(node) || bindingKey(nodeBinding(node)) === selected);
    return <label className="field"><span>{label}</span><select aria-label={label} value={selected} onChange={(event) => onChange(event.target.value)}>
      <option value="">{optional ? '不绑定' : '请选择实际字段'}</option>
      {shown.map((node) => <option key={bindingKey(nodeBinding(node))} value={bindingKey(nodeBinding(node))}>{node.nodeId}.{node.fieldName}{typeof node.description === 'string' && node.description ? ` · ${node.description}` : ''}</option>)}
    </select></label>;
  }
  function modal() {
    if (!dialog) return null;
    const title = dialog.kind === 'lora' ? '添加 / 修改 LoRA 位置' : dialog.kind === 'other' ? '添加其它参数' : `${dialog.edit.title} · 显示设置`;
    return <div className="rhv-import-backdrop rhv-extras-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}>
      <div ref={modalRef} className="rhv-import-dialog rhv-extras-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header><h3>{title}</h3><button type="button" className="btn small" onClick={closeDialog}>关闭</button></header>
        <div className="rhv-extras-dialog-fields">
          {dialog.kind === 'control' ? <>
            <label className="field"><span>控件类型</span><select aria-label="其它参数控件类型" value={dialog.edit.kind} onChange={(event) => setDialog({ ...dialog, edit: { ...dialog.edit, kind: event.target.value as RunningHubVideoFieldControl['kind'] } })}>
              <option value="text">文本输入</option><option value="number">数字输入</option><option value="select">选项列表（也可输入其它值）</option>
            </select></label>
            {dialog.edit.kind === 'select' && <label className="field rhv-extras-options"><span>实际候选值，每行一个</span><textarea aria-label="节点实际候选值" value={dialog.edit.options} onChange={(event) => setDialog({ ...dialog, edit: { ...dialog.edit, options: event.target.value } })} placeholder="使用云端实际文件名或字段选项" /></label>}
            {dialog.edit.kind !== 'text' && <div className="rhv-control-range">{(['min', 'max', 'step'] as const).map((key, index) => <label className="field" key={key}><span>{['最小值提示', '最大值提示', '步长'][index]}</span><input aria-label={['其它参数最小值', '其它参数最大值', '其它参数步长'][index]} value={dialog.edit[key]} onChange={(event) => setDialog({ ...dialog, edit: { ...dialog.edit, [key]: event.target.value } })} placeholder="不设置" /></label>)}</div>}
            <p className="vwm-help">选项按原值提交；填写云端支持的模型和参数值。范围仅作提示，保留手动输入。</p>
          </> : <>
            <label className="field"><span>查找实际字段</span><input aria-label="LoRA和其它节点搜索" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="节点编号、字段名或说明" /></label>
            {dialog.kind === 'lora' ? <>
              {fieldSelect('LoRA 模型位置', dialog.model, available.filter((node) => typeof node.fieldValue === 'string'), (model) => {
                const chosen = available.find((node) => bindingKey(nodeBinding(node)) === model);
                const find = (name: string) => available.find((node) => node.nodeId === chosen?.nodeId && node.fieldName.toLowerCase().replace(/[\s_-]+/gu, '') === name);
                const strength = find('strengthmodel'); const clipStrength = find('strengthclip');
                setDialog({ ...dialog, model, strength: strength ? bindingKey(nodeBinding(strength)) : '', clipStrength: clipStrength ? bindingKey(nodeBinding(clipStrength)) : '' });
              })}
              <div className="rhv-two-fields">
                {fieldSelect('LoRA 模型强度位置（可选）', dialog.strength, available.filter((node) => typeof node.fieldValue !== 'boolean'), (strength) => setDialog({ ...dialog, strength }), true)}
                {fieldSelect('LoRA CLIP 强度位置（可选）', dialog.clipStrength, available.filter((node) => typeof node.fieldValue !== 'boolean'), (clipStrength) => setDialog({ ...dialog, clipStrength }), true)}
              </div>
              <label className="field"><span>显示名称（可选）</span><input aria-label="LoRA位置名称" value={dialog.label} onChange={(event) => setDialog({ ...dialog, label: event.target.value })} placeholder="例如：自定义 LoRA 1" /></label>
            </> : fieldSelect('其它参数位置', dialog.field, otherCandidates, (field) => setDialog({ ...dialog, field }))}
            <p className="vwm-help">选择工作流实际开放的字段。缺少位置可先手动添加字段，再回到这里选择。</p>
            <button type="button" className="vwm-text-button" onClick={() => { closeDialog(); onManualNode(); }}>手动添加字段…</button>
          </>}
        </div>
        {error && <p className="rhv-extras-error" role="alert">{error}</p>}
        <footer><span className="vwm-help">{dialog.kind === 'control' ? bindingText(dialog.edit.binding) : '默认值将在保存工作流后用于生成'}</span><div><button type="button" className="btn small" onClick={closeDialog}>取消</button><button type="button" className="btn primary small" onClick={applyDialog}>应用</button></div></footer>
      </div>
    </div>;
  }

  const modalContent = modal();
  const modalHost = rootRef.current?.closest('.rhv-manager');
  return <div ref={rootRef} className="rhv-extras" data-section={section}>
    <div className="rhv-extras-heading"><span>{section === 'lora' ? `已展示 ${slots.length} 个 LoRA 槽位 · 自动识别 ${slots.filter((slot) => slot.automatic).length} 个` : `已添加 ${others.length} 个其它参数`}</span>
      <button type="button" className="btn small" onClick={() => section === 'lora' ? openLora() : beginDialog({ kind: 'other', field: '' })}>{section === 'lora' ? '添加 LoRA 位置' : '添加其它参数'}</button></div>
    {total ? <div className="rhv-extras-grid" data-capacity={capacity} data-columns={columns}>
      {section === 'lora' ? visibleSlots.map((slot, index) => <div className="rhv-extras-card rhv-extras-lora-card" key={bindingKey(slot.model)}>
        <div className="rhv-extras-card-heading"><strong title={slot.label || bindingText(slot.model)}>{slot.label || `LoRA ${currentPage * capacity + index + 1}`}</strong><div>
          <button type="button" className="vwm-text-button" aria-label={`配置LoRA位置 ${bindingText(slot.model)}`} onClick={() => openLora(slot)}>位置</button>
          <button type="button" className="vwm-text-button" aria-label={`配置LoRA候选 ${bindingText(slot.model)}`} onClick={() => openControl(slot.model, 'LoRA 模型')}>候选</button>
          <button type="button" className="vwm-text-button" aria-label={`移除LoRA展示 ${bindingText(slot.model)}`} onClick={() => onWorkflowChange(removeRunningHubLoraSlot(workflow, slot.model))}>移除</button>
        </div></div>
        {valueEditor(slot.model, 'LoRA 模型')}
        <div className="rhv-extras-strengths">{slot.strength ? valueEditor(slot.strength, '模型强度', true) : <p className="vwm-help">未绑定强度，可在“位置”中添加。</p>}{slot.clipStrength && valueEditor(slot.clipStrength, 'CLIP 强度', true)}</div>
      </div>) : visibleOthers.map((binding) => {
        const node = nodeFor(binding);
        return <div className="rhv-extras-card" key={bindingKey(binding)}>
          <div className="rhv-extras-card-heading"><strong title={bindingText(binding)}>{bindingText(binding)}</strong><div>
            <button type="button" className="vwm-text-button" aria-label={`配置其它参数 ${bindingText(binding)}`} onClick={() => openControl(binding, binding.inputName)}>显示设置</button>
            <button type="button" className="vwm-text-button" aria-label={`移除其它参数展示 ${bindingText(binding)}`} onClick={() => onWorkflowChange(removeRunningHubOtherField(workflow, binding))}>移除</button>
          </div></div>
          {valueEditor(binding, '工作流默认值')}
          {typeof node?.description === 'string' && node.description && <p className="vwm-help rhv-extras-description" title={node.description}>{node.description}</p>}
        </div>;
      })}
    </div> : <div className="rhv-extras-empty"><p>{section === 'lora' ? '尚未识别到请求中的 LoRA 字段。读取云端节点或手动指定已有 LoRA 位置。' : '点击“添加其它参数”选择主模型、开关等自定义字段。'}</p><div>
      <button type="button" className="btn small" disabled={discovering} onClick={onReadNodes}>{discovering ? '读取中…' : '读取云端节点'}</button><button type="button" className="btn small" onClick={onImportNodes}>导入节点 JSON</button>
    </div></div>}
    <div className="vwm-pager rhv-extras-pager" aria-label={`${section === 'lora' ? 'LoRA' : '其它参数'}分页`}><span>{total} 项</span><div><button type="button" className="btn small" aria-label={`${section === 'lora' ? 'LoRA' : '其它参数'}上一页`} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>‹</button><span>{currentPage + 1} / {pages}</span><button type="button" className="btn small" aria-label={`${section === 'lora' ? 'LoRA' : '其它参数'}下一页`} disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>›</button></div></div>
    <p className="vwm-help rhv-extras-note">{section === 'lora' ? '选择云端支持的实际 LoRA 文件名；候选从节点选项读取，也可手动配置。' : '可手动配置文本、数字或下拉选项，按实际字段和原类型提交。'} 移除只收起展示，保留请求中的原值。</p>
    {modalContent && modalHost ? createPortal(modalContent, modalHost) : modalContent}
  </div>;
}
