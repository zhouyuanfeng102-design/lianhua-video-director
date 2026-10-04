import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import ts from 'typescript';
import { defaultRhTvApi, rhtvModes, type RhTvBridgeJob, type RhTvBridgeStatus, type RhTvControlRequest } from '../src/rhtvBridge';
import { formatUserFacingError } from '../src/userFacingError';

const source = readFileSync(new URL('../src/components/RhTvBridgeSettings.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source.slice(source.indexOf('export function')).replace('export function', 'function'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
}).outputText;
type Element = React.ReactElement<Record<string, any>>;
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : React.isValidElement(node)
  ? text((node as Element).props.children) : node == null || typeof node === 'boolean' ? '' : String(node);
const nodes = (node: any): Element[] => Array.isArray(node) ? node.flatMap(nodes) : React.isValidElement(node)
  ? [node as Element, ...nodes((node as Element).props.children)] : [];

// Run the production component callbacks without a browser or desktop service.
async function harness(jobs: RhTvBridgeJob[] = [], desktop = true) {
  let status: RhTvBridgeStatus = { running: true, browser: 'mock Edge', automatic_submission: false,
    live_site_verified: false, message: 'mock status', jobs };
  let cursor = 0; let tree: React.ReactNode; let changed = false;
  const slots: Array<{ value?: any; deps?: any[]; cleanup?: () => void }> = [];
  let effects: Array<() => void> = [];
  const calls: RhTvControlRequest[] = []; const confirmations: string[] = [];
  const answers: boolean[] = []; let block: Promise<void> | undefined;
  const icon = () => null;
  const dependencies = {
    React, rhtvModes, formatUserFacingError,
    ExternalLink: icon, FolderOpen: icon, LogIn: icon, Play: icon, RefreshCw: icon, Square: icon, Upload: icon, X: icon,
    useState: (initial: any) => {
      const index = cursor++; slots[index] ||= { value: initial };
      return [slots[index].value, (value: any) => { if (!Object.is(value, slots[index].value)) { slots[index].value = value; changed = true; } }];
    },
    useRef: (initial: any) => { const index = cursor++; slots[index] ||= { value: { current: initial } }; return slots[index].value; },
    useEffect: (effect: () => (() => void) | void, deps: any[]) => {
      const index = cursor++; const old = slots[index];
      if (old?.deps && deps.every((value, i) => Object.is(value, old.deps?.[i]))) return;
      slots[index] = { deps };
      effects.push(() => { old?.cleanup?.(); slots[index].cleanup = effect() || undefined; });
    },
    window: {
      setInterval: () => 1,
      confirm: (message: string) => { confirmations.push(message); return answers.shift() ?? false; },
      lianhuaDesktop: desktop ? { rhtvControl: async (request: RhTvControlRequest) => {
        calls.push(request); if (request.action !== 'status') await block;
        if (request.action === 'automation') status = { ...status, automatic_submission: request.enabled === true };
        return status;
      } } : undefined,
    },
    clearInterval: () => {},
  };
  const Component = new Function(...Object.keys(dependencies), `${compiled};return RhTvBridgeSettings;`)(...Object.values(dependencies));
  function render() {
    for (let count = 0; count < 10; count += 1) {
      changed = false; cursor = 0; tree = Component({ config: defaultRhTvApi, onChange: () => {} });
      const pending = effects; effects = []; pending.forEach((effect) => effect());
      if (!changed) return;
    }
    throw new Error('component did not settle');
  }
  async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); render(); }
  render(); await settle();
  const find = (label: string) => nodes(tree).find((node) => node.props['aria-label'] === label || node.type === 'button' && text(node) === label);
  const get = (label: string) => { const node = find(label); assert.ok(node, label); return node; };
  return { calls, confirmations, answers, find, get, render, settle,
    toggle: (checked: boolean) => { const input = get('rhTV 零费用自动执行'); assert.ok(!input.props.disabled); input.props.onChange({ target: { checked } }); },
    block: (promise: Promise<void> | undefined) => { block = promise; },
    dispose: () => slots.forEach((slot) => slot.cleanup?.()),
  };
}

const h = await harness();
try {
  h.toggle(true); await h.settle();
  assert.equal(h.calls.some((call) => call.action === 'automation'), false, 'declined consent never enables upload');
  assert.match(h.confirmations[0], /原图.*上传到 rhTV/);
  let release!: () => void; h.block(new Promise((resolve) => { release = resolve; })); h.answers.push(true);
  h.toggle(true); h.toggle(true); h.render();
  assert.equal(h.calls.filter((call) => call.action === 'automation').length, 1, 'same-render double toggle is deduplicated');
  assert.equal(h.get('rhTV 零费用自动执行').props.disabled, true);
  release(); h.block(undefined); await h.settle();
  assert.equal(h.get('rhTV 零费用自动执行').props.checked, true);
  h.toggle(false); await h.settle();
  assert.equal(h.calls.at(-1)?.action === 'status' || h.calls.at(-1)?.enabled === false, true);
  assert.equal(h.get('rhTV 零费用自动执行').props.checked, false);
} finally { h.dispose(); }

const job: RhTvBridgeJob = { id: 'local-one', client_id: 'client-one', mode: 'reference', reference_count: 1,
  created_at: 1, status: 'running', handed_off: true, automatic: true, submission_started: true,
  upstream_task_id: 'remote-one', message: 'running', references: [] };
const running = await harness([job]);
try {
  assert.equal(running.find('核实未提交并取消'), undefined, 'known remote task must not be called unsubmitted');
  assert.equal(running.get('取消待提交任务').props.disabled, true);
  running.get('继续原任务查询/下载').props.onClick(); await running.settle();
  assert.ok(running.calls.some((call) => call.action === 'retry' && call.jobId === job.id));
} finally { running.dispose(); }
const offline = await harness([], false);
try { assert.equal(offline.get('rhTV 零费用自动执行').props.disabled, true); }
finally { offline.dispose(); }
console.log('rhTV settings: opt-in consent, duplicate actions, pause, original-task recovery and desktop-only controls passed');
