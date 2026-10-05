import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { imageAssetKindLabel, imageGenerationStatusLabel } from '../src/generationTasks';
import { getImageVariantGenerationSpec } from '../src/imageGeneration';
import { canRegenerateImageTask, imageRegenerationRootId } from '../src/imageRegeneration';
import { assetPreviewUrl } from '../src/media';
import { formatUserFacingError } from '../src/userFacingError';
import { imageTaskRuleMetadata } from '../src/imageTaskRuleMetadata';
import type { ImageGenerationTask } from '../src/types';

// Exercise the real task-card JSX and click handler, including the shared native
// Button implementation. No browser, clipboard, network or project files mutate.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const taskView = parsed.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'GenerationTasksView');
assert.ok(taskView?.body);
const card = taskView.body.statements.find((node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((entry) => entry.name.getText(parsed) === 'renderImageTaskCard'));
assert.ok(card, 'the image-task production renderer must be covered');
const displayDeclarations = parsed.statements.filter((node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((entry) => ['Button', 'Card', 'Badge'].includes(entry.name.getText(parsed))));
assert.equal(displayDeclarations.length, 3);
const compiled = ts.transpileModule([...displayDeclarations, card].map((node) => node.getText(parsed)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
}).outputText;

interface Props {
  children?: React.ReactNode;
  onClick?: () => void | Promise<void>;
  disabled?: boolean;
  type?: string;
  title?: string;
  className?: string;
  'aria-label'?: string;
}
type Node = React.ReactElement<Props>;
const nodesOf = (value: React.ReactNode): Node[] => {
  if (Array.isArray(value)) return value.flatMap(nodesOf);
  if (!React.isValidElement<Props>(value)) return [];
  return [value, ...nodesOf(typeof value.type === 'function'
    ? (value.type as (props: Props) => React.ReactNode)(value.props)
    : value.props.children)];
};
const textOf = (value: React.ReactNode): string => {
  if (value == null || typeof value === 'boolean') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textOf).join('');
  return React.isValidElement<Props>(value) ? textOf(value.props.children) : '';
};
const fixture = (patch: Partial<ImageGenerationTask> = {}): ImageGenerationTask => ({
  id: 'image-copy-1', kind: 'image', name: '人物甲 · 第 1/3 张', assetKind: 'character', imageVariant: 'full-body',
  status: 'running', prompt: '本次最终提示词', negativePrompt: '不应复制的负面提示词', width: 1536, height: 1024,
  backend: 'openai', model: 'test-model', createdAt: 1, updatedAt: 2, ...patch,
});
const unexpected = () => { throw new Error('copy must not invoke task actions or project mutation'); };
const setup = (taskList: ImageGenerationTask[], copy: (text: string) => Promise<boolean> = async () => true) => {
  const copied: string[] = [];
  const notices: Array<[string, string]> = [];
  const state = { project: { id: 'copy-fixture', assets: [], generationTasks: taskList } };
  const initial = JSON.stringify(state);
  const dependencies = {
    React, state, tasks: taskList, assetPreviewUrl,
    getImageVariantGenerationSpec, canRegenerateImageTask, imageRegenerationRootId,
    imageAssetKindLabel, imageGenerationStatusLabel, formatUserFacingError, imageTaskRuleMetadata,
    taskChapterLabel: () => '项目共享 / 历史任务',
    storyboardImageBatchLifecycle: { isActive: () => false },
    Copy: () => null, RefreshCw: () => null, X: () => null, Trash2: () => null, Eye: () => null,
    copyText: async (text: string) => { copied.push(text); return copy(text); },
    notify: (message: string, tone: string) => notices.push([message, tone]),
    ctx: new Proxy({}, { get: unexpected }),
    setState: unexpected, setView: unexpected, removeTask: unexpected, regenerateImageTask: unexpected,
  };
  const render = new Function(...Object.keys(dependencies), `${compiled}\nreturn renderImageTaskCard;`)(...Object.values(dependencies)) as (task: ImageGenerationTask) => React.ReactElement;
  const button = (task: ImageGenerationTask): Node => {
    const node = nodesOf(render(task)).find((item) => item.type === 'button'
      && textOf(item.props.children) === '复制最终提示词');
    assert.ok(node, 'each task exposes a native copy button');
    return node;
  };
  return { copied, notices, render, button, assertUnchanged: () => assert.equal(JSON.stringify(state), initial) };
};
let count = 0;
const test = async (name: string, run: () => void | Promise<void>) => {
  await run(); count += 1; console.log(`PASS ${name}`);
};

await test('复制完整原文：保留前后空白、换行、中英文和超长末尾，不含省略或负面提示词', async () => {
  const prompt = `  第一行：完整中文。\r\nSecond line: \"quoted\"\n${'长正文🎥'.repeat(1500)}\n最后一句不能丢。  `;
  const task = fixture({ prompt });
  const qa = setup([task]);
  const button = qa.button(task);
  assert.equal(button.props.disabled, false);
  assert.equal(button.props.type, 'button', 'copy does not submit a form');
  assert.match(button.props['aria-label'] || '', /人物甲.*最终提示词/u);
  assert.match(button.props.title || '', /不受预览省略影响/u);
  assert.ok(nodesOf(qa.render(task)).some((item) => item.props.className === 'field-hint job-prompt'), 'compact preview is retained');
  await button.props.onClick!();
  assert.deepEqual(qa.copied, [prompt]);
  assert.deepEqual(qa.notices, [[`已复制「${task.name}」的完整最终提示词。`, 'normal']]);
  qa.assertUnchanged();
});

await test('已排队、生成中、成功和失败任务只要有最终提示词均可复制', async () => {
  for (const status of ['queued', 'running', 'succeeded', 'failed'] as const) {
    const task = fixture({ status });
    const qa = setup([task]);
    assert.equal(qa.button(task).props.disabled, false, status);
    await qa.button(task).props.onClick!();
    assert.deepEqual(qa.copied, [task.prompt]);
    qa.assertUnchanged();
  }
});

await test('暂无最终提示词时禁用；直接调用回调也不复制等待占位', async () => {
  for (const prompt of ['', '   \n\t']) {
    const task = fixture({ status: 'queued', prompt });
    const qa = setup([task]);
    const button = qa.button(task);
    assert.equal(button.props.disabled, true);
    assert.match(button.props.title || '', /尚未生成/u);
    if (!prompt) assert.match(renderToStaticMarkup(qa.render(task)), /等待转换器生成最终生图提示词/u);
    await button.props.onClick!();
    assert.deepEqual(qa.copied, []);
    assert.deepEqual(qa.notices, []);
    qa.assertUnchanged();
  }
});

await test('转换器返回后同一任务按钮恢复并复制新最终提示词', async () => {
  const queued = fixture({ status: 'queued', prompt: '' });
  const qa = setup([queued]);
  assert.equal(qa.button(queued).props.disabled, true);
  const converted = { ...queued, status: 'running' as const, prompt: 'AI 返回完整提示词\n末尾' };
  assert.equal(qa.button(converted).props.disabled, false);
  await qa.button(converted).props.onClick!();
  assert.deepEqual(qa.copied, [converted.prompt]);
  qa.assertUnchanged();
});

await test('剪贴板返回失败时明确提示且不改任务或重试生图', async () => {
  const task = fixture();
  const qa = setup([task], async () => false);
  await qa.button(task).props.onClick!();
  assert.equal(qa.notices.length, 1);
  assert.equal(qa.notices[0][1], 'error');
  assert.match(qa.notices[0][0], /未能复制「人物甲 · 第 1\/3 张」.*剪贴板权限/u);
  qa.assertUnchanged();
});

await test('剪贴板回退抛错时处理异常并给出失败反馈', async () => {
  const task = fixture();
  const qa = setup([task], async () => { throw new Error('execCommand denied'); });
  await assert.doesNotReject(async () => qa.button(task).props.onClick!());
  assert.equal(qa.notices.length, 1);
  assert.equal(qa.notices[0][1], 'error');
  assert.match(qa.notices[0][0], /未能复制/u);
  qa.assertUnchanged();
});

await test('连续复制多个任务时原文和反馈分别绑定对应任务', async () => {
  const first = fixture();
  const second = fixture({ id: 'image-copy-2', name: '人物乙 · 第 2/3 张', prompt: '第二个任务的原文' });
  const pending: Array<(result: boolean) => void> = [];
  const qa = setup([first, second], () => new Promise<boolean>((resolve) => pending.push(resolve)));
  const a = qa.button(first).props.onClick!();
  const b = qa.button(second).props.onClick!();
  assert.deepEqual(qa.copied, [first.prompt, second.prompt]);
  pending[1](true); await b;
  pending[0](false); await a;
  assert.match(qa.notices[0][0], /已复制「人物乙 · 第 2\/3 张」/u);
  assert.match(qa.notices[1][0], /未能复制「人物甲 · 第 1\/3 张」/u);
  assert.deepEqual(qa.notices.map((notice) => notice[1]), ['normal', 'error']);
  qa.assertUnchanged();
});

console.log(`task prompt copy: ${count} groups passed`);
