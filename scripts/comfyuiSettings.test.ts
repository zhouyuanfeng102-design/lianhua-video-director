import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const componentPath = '../src/components/' + 'ComfyUISettings';
const componentModule = await import(componentPath).catch(() => ({})) as {
  ComfyUISettings?: React.ComponentType<any>;
};

assert.equal(
  typeof componentModule.ComfyUISettings,
  'function',
  'the image API page needs a dedicated ComfyUI settings surface',
);

const markup = renderToStaticMarkup(React.createElement(componentModule.ComfyUISettings!, {
  config: {
    enabled: true,
    backend: 'comfyui',
    baseUrl: 'http://127.0.0.1:8188',
    apiKey: '',
    model: '',
    workflowJson: '{"1":{}}',
    comfyuiPathMode: 'preset',
    comfyuiPromptPath: '/prompt',
    comfyuiWorkflows: [{
      id: 'wf-1',
      name: '角色图工作流',
      workflowJson: '{"1":{}}',
      createdAt: 1,
      updatedAt: 1,
    }],
    activeComfyuiWorkflowId: 'wf-1',
  },
  allowPrivateNetwork: false,
  onChange: () => undefined,
  onPrivateNetworkChange: () => undefined,
}));

for (const expected of [
  '接口路径模式',
  '/prompt',
  'ComfyUI Workflow JSON',
  '新增工作流',
  '删除当前',
  '导入 API JSON',
  '当前实际生效',
  '角色图工作流',
  '允许访问本机与局域网模型端点',
  '__PROMPT__',
  '__NEGATIVE_PROMPT__',
  '__WIDTH__',
  '__HEIGHT__',
  '__REFERENCE_IMAGE_1__',
  '真实图片',
  'LoadImage',
]) {
  assert.match(markup, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
}

assert.doesNotMatch(markup, /当前仅保留提示词资产/u);

console.log('dedicated ComfyUI settings surface checks passed');
