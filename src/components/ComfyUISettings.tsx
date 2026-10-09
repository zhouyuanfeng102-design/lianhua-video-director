import { useMemo, useRef, useState, type ChangeEvent } from 'react';

import {
  importComfyUIApiWorkflow,
  normalizeComfyUIImageConfig,
  synchronizeComfyUIWorkflows,
  type ComfyUIWorkflowEntry,
} from '../comfyui';
import type { ImageApiConfig } from '../types';
import { formatUserFacingError } from '../userFacingError';

type ComfyUISettingsConfig = ImageApiConfig & {
  comfyuiWorkflows?: ComfyUIWorkflowEntry[];
  activeComfyuiWorkflowId?: string | null;
  comfyuiPathMode?: 'preset' | 'custom';
  comfyuiPromptPath?: string;
};

export interface ComfyUISettingsProps {
  config: ComfyUISettingsConfig;
  allowPrivateNetwork: boolean;
  onChange: (patch: Partial<ComfyUISettingsConfig>) => void;
  onPrivateNetworkChange: (allowed: boolean) => void;
}

const createWorkflowId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `comfy-workflow-${crypto.randomUUID()}`;
  }
  return `comfy-workflow-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
};

const workflowNameFromFile = (fileName: string, fallbackIndex: number): string => {
  const withoutExtension = fileName.replace(/\.json$/iu, '').trim();
  return withoutExtension || `工作流 ${fallbackIndex}`;
};

export function ComfyUISettings({
  config,
  allowPrivateNetwork,
  onChange,
  onPrivateNetworkChange,
}: ComfyUISettingsProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importMessage, setImportMessage] = useState('');
  const [importError, setImportError] = useState('');
  const [managerOpen, setManagerOpen] = useState(false);

  const normalizedConfig = useMemo(
    () => normalizeComfyUIImageConfig(config),
    [config],
  );
  const workflows = normalizedConfig.comfyuiWorkflows;
  const activeWorkflowId = normalizedConfig.activeComfyuiWorkflowId ?? '';
  const activeWorkflow = workflows.find((workflow) => workflow.id === activeWorkflowId);
  const pathMode = normalizedConfig.comfyuiPathMode;
  const promptPath = pathMode === 'preset'
    ? '/prompt'
    : normalizedConfig.comfyuiPromptPath;

  const commitWorkflows = (
    nextWorkflows: ComfyUIWorkflowEntry[],
    nextActiveId?: string,
  ) => {
    onChange(synchronizeComfyUIWorkflows(nextWorkflows, nextActiveId));
  };

  const updateActiveWorkflow = (
    patch: Partial<Pick<ComfyUIWorkflowEntry, 'name' | 'workflowJson'>>,
  ) => {
    if (!activeWorkflow) return;
    const now = Date.now();
    const nextWorkflows = workflows.map((workflow) => (
      workflow.id === activeWorkflow.id
        ? { ...workflow, ...patch, updatedAt: now }
        : workflow
    ));
    commitWorkflows(nextWorkflows, activeWorkflow.id);
  };

  const addWorkflow = () => {
    const now = Date.now();
    const workflow: ComfyUIWorkflowEntry = {
      id: createWorkflowId(),
      name: `工作流 ${workflows.length + 1}`,
      workflowJson: '{}',
      createdAt: now,
      updatedAt: now,
    };
    setImportMessage('');
    setImportError('');
    commitWorkflows([...workflows, workflow], workflow.id);
  };

  const deleteActiveWorkflow = () => {
    if (!activeWorkflow) return;
    const currentIndex = workflows.findIndex((workflow) => workflow.id === activeWorkflow.id);
    const nextWorkflows = workflows.filter((workflow) => workflow.id !== activeWorkflow.id);
    const nextActive = nextWorkflows[Math.min(currentIndex, nextWorkflows.length - 1)];
    setImportMessage('');
    setImportError('');
    commitWorkflows(nextWorkflows, nextActive?.id);
  };

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setImportMessage('');
    setImportError('');
    try {
      const imported = importComfyUIApiWorkflow(await file.text());
      const now = Date.now();
      if (activeWorkflow) {
        const nextWorkflows = workflows.map((workflow) => (
          workflow.id === activeWorkflow.id
            ? { ...workflow, workflowJson: imported.workflowJson, updatedAt: now }
            : workflow
        ));
        commitWorkflows(nextWorkflows, activeWorkflow.id);
      } else {
        const workflow: ComfyUIWorkflowEntry = {
          id: createWorkflowId(),
          name: workflowNameFromFile(file.name, 1),
          workflowJson: imported.workflowJson,
          createdAt: now,
          updatedAt: now,
        };
        commitWorkflows([workflow], workflow.id);
      }
      setImportMessage(
        `导入成功：正面提示词 ${imported.positiveCount} 个，负面提示词 ${imported.negativeCount} 个，尺寸字段 ${imported.widthCount + imported.heightCount + imported.targetWidthCount + imported.targetHeightCount} 个，可用参考图节点 ${imported.referenceImageCount} 个。`,
      );
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'ComfyUI API JSON 导入失败。');
    }
  };

  return (
    <div className="comfyui-settings">
      <div className="api-fields-two">
        <label className="field">
          <span>接口路径模式</span>
          <select
            value={pathMode}
            onChange={(event) => {
              const nextMode = event.target.value === 'custom' ? 'custom' : 'preset';
              onChange({
                comfyuiPathMode: nextMode,
                comfyuiPromptPath: nextMode === 'preset'
                  ? '/prompt'
                  : normalizedConfig.comfyuiPromptPath || '/prompt',
              });
            }}
          >
            <option value="preset">标准 ComfyUI（/prompt）</option>
            <option value="custom">自定义接口路径</option>
          </select>
        </label>
        <label className="field">
          <span>提交路径</span>
          <input
            value={promptPath}
            disabled={pathMode === 'preset'}
            onChange={(event) => onChange({ comfyuiPromptPath: event.target.value })}
            placeholder="/prompt"
          />
          <span className="field-hint">
            {pathMode === 'preset' ? '预设模式固定使用 /prompt。' : '只填写相对路径，例如 /prompt；完整服务地址填写在上方根地址。'}
          </span>
        </label>
      </div>

      <label className="check-row">
        <input
          type="checkbox"
          checked={allowPrivateNetwork}
          onChange={(event) => onPrivateNetworkChange(event.target.checked)}
        />
        允许访问本机与局域网模型端点
      </label>

      <div className="api-fields-two">
        <label className="field">
          <span>当前 Workflow</span>
          <select
            value={activeWorkflowId}
            disabled={workflows.length === 0}
            onChange={(event) => commitWorkflows(workflows, event.target.value)}
          >
            {workflows.length === 0 && <option value="">尚未添加工作流</option>}
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
            ))}
          </select>
        </label>
        <div className="field">
          <span>Workflow 操作</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <button
              type="button"
              className="btn small"
              onClick={() => fileInputRef.current?.click()}
            >
              导入 API JSON
            </button>
            <button type="button" className="btn small" onClick={() => setManagerOpen(true)}>
              管理 Workflow
            </button>
          </div>
        </div>
      </div>

      <input
        ref={fileInputRef}
        className="file-input"
        type="file"
        accept="application/json,.json"
        onChange={handleImport}
      />
      {importMessage && <div className="field-hint" role="status">{importMessage}</div>}
      {importError && <div className="field-hint" role="alert">{formatUserFacingError(importError)}</div>}

      <div className="hint-box">
        <strong>当前实际生效：</strong>{' '}
        {activeWorkflow ? `${activeWorkflow.name}（${activeWorkflow.id}）` : '无工作流'}
        {' · '}{workflows.length} 个已保存 Workflow
      </div>

      <div
        className="modal-backdrop"
        hidden={!managerOpen}
        aria-hidden={!managerOpen}
        onMouseDown={() => setManagerOpen(false)}
      >
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-label="ComfyUI Workflow 管理"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="modal-head">
            <div>
              <h3>ComfyUI Workflow 管理</h3>
              <div className="field-hint">保存多个 API Workflow，并明确选择当前实际生效项。</div>
            </div>
            <button type="button" className="btn small" onClick={() => setManagerOpen(false)}>
              关闭
            </button>
          </div>

          <div style={{ display: 'grid', gap: 10 }}>
            <div className="api-fields-two">
              <label className="field">
                <span>选择 Workflow</span>
                <select
                  value={activeWorkflowId}
                  disabled={workflows.length === 0}
                  onChange={(event) => commitWorkflows(workflows, event.target.value)}
                >
                  {workflows.length === 0 && <option value="">尚未添加工作流</option>}
                  {workflows.map((workflow) => (
                    <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Workflow 名称</span>
                <input
                  value={activeWorkflow?.name ?? ''}
                  disabled={!activeWorkflow}
                  onChange={(event) => updateActiveWorkflow({ name: event.target.value })}
                  placeholder="例如：角色图工作流"
                />
              </label>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <button type="button" className="btn small" onClick={addWorkflow}>
                新增工作流
              </button>
              <button
                type="button"
                className="btn small danger"
                disabled={!activeWorkflow}
                onClick={deleteActiveWorkflow}
              >
                删除当前
              </button>
              <button
                type="button"
                className="btn small"
                onClick={() => fileInputRef.current?.click()}
              >
                导入 API JSON
              </button>
            </div>

            <div className="hint-box">
              <strong>当前实际生效：</strong>{' '}
              {activeWorkflow ? `${activeWorkflow.name}（${activeWorkflow.id}）` : '无工作流'}
            </div>

            <label className="field">
              <span>ComfyUI Workflow JSON</span>
              <textarea
                className="mono"
                rows={14}
                value={activeWorkflow?.workflowJson ?? ''}
                disabled={!activeWorkflow}
                onChange={(event) => updateActiveWorkflow({ workflowJson: event.target.value || '{}' })}
                placeholder="请导入 ComfyUI 的 API 格式 JSON，或在此粘贴。"
                spellCheck={false}
              />
            </label>

            <div className="hint-box">
              导入 API JSON 时会识别正负提示词，仅为唯一生成画布及匹配的尺寸条件绑定宽高；缩放、裁剪、参考图预处理与其他阶段尺寸保留原值。明确尺寸标记优先，不会同时扩大前面的画布。直接粘贴原始 API JSON 时，生成前也会按此规则转换。采样参数和 Seed 默认保留 Workflow 原值，只有明确写入下列占位符时才替换：
              <code>__PROMPT__</code> 正面提示词、
              <code>__NEGATIVE_PROMPT__</code> 负面提示词、
              <code>__WIDTH__</code> 宽度、
              <code>__HEIGHT__</code> 高度、
              <code>__TARGET_WIDTH__</code> 目标宽度、
              <code>__TARGET_HEIGHT__</code> 目标高度、
              <code>__SIZE__</code> 尺寸、
              <code>__STEPS__</code> 迭代步数、
              <code>__CFG__</code> CFG、
              <code>__CFG_RESCALE__</code> CFG Rescale、
              <code>__SAMPLER__</code> 采样器、
              <code>__SCHEDULER__</code> 调度器、
              <code>__SEED__</code> 随机种子、
              <code>__SMEA__</code> SMEA、
              <code>__SMEA_DYN__</code> SMEA Dynamic。
              尺寸标记只说明可以传入宽高，不证明当前模型具有原生 2K / 4K 能力；请在生图 API 设置中明确确认支持档位。旧模板若把多个阶段全部改成尺寸占位符，请重新导入原始 API JSON，不能凭空恢复丢失的原尺寸。
              勾选参考图时会先上传真实图片到 ComfyUI，再注入连接到输出的标准 <code>LoadImage</code> 节点；自定义加载节点可使用
              <code>__REFERENCE_IMAGE_1__</code>、<code>__REFERENCE_IMAGE_2__</code> 等占位符。工作流没有有效参考链时会停止并明确报错。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
