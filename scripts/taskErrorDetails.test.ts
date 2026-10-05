import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as diagnostics from '../src/errorDiagnostics';
import * as userFacing from '../src/userFacingError';
import { videoProviderErrorDiagnostics } from '../src/videoTaskErrorDiagnostics';

let groups = 0;
const test = (name: string, action: () => void) => { action(); groups += 1; console.log(`PASS ${name}`); };
const testAsync = async (name: string, action: () => Promise<void>) => { await action(); groups += 1; console.log(`PASS ${name}`); };

test('RunningHub 合图异常显示 node_name 节点名称，不泄漏输入或猜测缺图槽位', () => {
  const failedReason = Object.freeze({
    node_id: '858', node_name: 'BatchImagesNode', exception_type: 'AttributeError',
    exception_message: "'NoneType' object has no attribute 'shape'",
    current_inputs: { image: 'private-image-input' }, traceback: ['private-traceback-path'],
  });
  for (const reason of [failedReason, JSON.stringify(failedReason)]) {
    const result = videoProviderErrorDiagnostics({ code: 805, msg: '工作流运行失败', data: { failedReason: reason } });
    assert.equal(result?.code, '805');
    assert.match(result!.message, /节点：858；节点类型：BatchImagesNode；异常类型：AttributeError/u);
    assert.match(result!.message, /'NoneType' object has no attribute 'shape'/u);
    assert.doesNotMatch(result!.message, /private-image-input|private-traceback-path|429|第六槽|第 6 槽/u);
  }
  assert.match(videoProviderErrorDiagnostics({ failedReason: { ...failedReason, node_type: 'ExplicitNodeType' } })!.message,
    /节点类型：ExplicitNodeType/u, 'an explicit node type remains authoritative');
  assert.match(videoProviderErrorDiagnostics({ failedReason: { ...failedReason, node_type: '' } })!.message,
    /节点类型：BatchImagesNode/u, 'an empty alias must not hide the returned node name');
  let invoked = false;
  const getter = Object.defineProperty({ node_id: '858' }, 'node_name', { get: () => { invoked = true; throw new Error('not a data field'); } });
  assert.doesNotThrow(() => videoProviderErrorDiagnostics({ failedReason: getter }));
  assert.equal(invoked, false);
});

test('TLS 原文、状态码、阶段和路由保留，不读取任意请求对象', () => {
  const error = Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), {
    status: 502, code: 'ECONNRESET', stage: 'image-generation', route: 'system-proxy',
    endpoint: 'https://username:password@api.example.invalid/v1/images/generations?token=url-secret#fragment',
    config: { headers: { Authorization: 'secret-in-config' }, body: 'private prompt' },
  });
  Object.freeze(error);
  const detail = diagnostics.formatSafeErrorDiagnostics(error);
  assert.match(detail, /Client network socket disconnected before secure TLS connection was established/u);
  assert.match(detail, /HTTP 状态：502/u);
  assert.match(detail, /错误码：ECONNRESET/u);
  assert.match(detail, /阶段：image-generation/u);
  assert.match(detail, /传输路由：system-proxy/u);
  assert.match(detail, /服务地址（仅域名）：https:\/\/api\.example\.invalid/u);
  assert.doesNotMatch(detail, /username|password|url-secret|fragment|private prompt|secret-in-config|\/v1\//u);
  assert.equal(error.message, 'Client network socket disconnected before secure TLS connection was established');
});

test('未知英文与字符串携带的 HTTP/code/stage/route 可在技术详情看到', () => {
  const detail = diagnostics.getSafeErrorDiagnostics('Provider reported a previously unseen transport fault; HTTP 503; code=UPSTREAM_UNAVAILABLE; stage=tls-connect; route=direct');
  assert.match(detail.message, /previously unseen transport fault/u);
  assert.equal(detail.status, 503);
  assert.equal(detail.code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(detail.stage, 'tls-connect');
  assert.equal(detail.route, 'direct');
  assert.equal(diagnostics.getSafeErrorDiagnostics('连接失败； 阶段：握手; 传输路由：系统代理').stage, '握手');
  assert.equal(diagnostics.getSafeErrorDiagnostics('{"stage":"tls-connect","route":"direct"}').route, 'direct');
  assert.doesNotMatch(diagnostics.formatSafeErrorDiagnostics({ endpoint: 'user:password@host/private' }), /password|private/u);
});

test('桌面 transport 的 network 字段别名与中文元数据保留握手阶段和路由', () => {
  const message = 'Client network socket disconnected before secure TLS connection was established（错误码：ECONNRESET；阶段：TLS 握手；接口：https://api.example.invalid；路由：系统代理；未取得 HTTP 响应）';
  const structured = diagnostics.getSafeErrorDiagnostics(Object.assign(new Error(message), {
    networkStage: 'TLS 握手', networkRoute: '系统代理',
    networkEndpoint: 'https://user:password@api.example.invalid/v1/images?token=private-url-key',
  }));
  const legacyString = diagnostics.getSafeErrorDiagnostics(message);
  for (const detail of [structured, legacyString]) {
    assert.equal(detail.stage, 'TLS 握手');
    assert.equal(detail.route, '系统代理');
    assert.equal(detail.endpoint, 'https://api.example.invalid');
    assert.equal(detail.code, 'ECONNRESET');
    assert.equal(detail.status, undefined, 'no HTTP response must not invent a status');
    assert.doesNotMatch(JSON.stringify(detail), /password|private-url-key/u);
  }
  let invoked = false;
  const withGetter = Object.defineProperty({ message }, 'networkRoute', { get: () => { invoked = true; throw new Error('not a data field'); } });
  assert.equal(diagnostics.getSafeErrorDiagnostics(withGetter).route, '系统代理');
  assert.equal(invoked, false);
});

test('IPv6 URL 保留完整 origin，路径、查询和 URL 凭据不会从右方括号后泄漏', () => {
  const urls = [
    'https://[2001:db8::1]:8443/private-credential/path?unusual=another-private-value#private-fragment',
    'https://user:private-password@[2001:db8::1]:8443/private-credential/path?unusual=another-private-value',
  ];
  for (const url of urls) {
    for (const error of [
      `TLS failed; endpoint=${url}`,
      `连接失败（接口：${url}；阶段：TLS 握手）`,
      { message: 'TLS failed', endpoint: url },
      { message: 'TLS failed', networkEndpoint: url },
    ]) {
      const detail = diagnostics.getSafeErrorDiagnostics(error);
      assert.equal(detail.endpoint, 'https://[2001:db8::1]:8443');
      assert.doesNotMatch(diagnostics.formatSafeErrorDiagnostics(error), /private-credential|another-private-value|private-fragment|private-password|unusual=/u);
    }
  }
});

test('JSON 引号、转义引号与多行敏感 payload 保守隐藏余下正文', () => {
  const labels = ['requestBody', 'request_body', 'responseBody', 'systemPrompt', 'user_prompt', 'prompt', 'prompts', 'sourceStoryContent', 'source_story', 'body', 'payload', 'messages', 'input', 'b64_json'];
  for (const label of labels) {
    const source = `HTTP 400 invalid request; {"${label}": {\n "nested": "sensitive-echo",\n "extra": "private-content"\n}}`;
    const detail = diagnostics.formatSafeErrorDiagnostics(source);
    assert.match(detail, /HTTP 400/u, label);
    assert.match(detail, /已脱敏/u, label);
    assert.doesNotMatch(detail, /sensitive-echo|private-content/u, label);
    assert.doesNotMatch(diagnostics.formatSafeErrorDiagnostics(source.replace(/"/gu, '\\"')), /sensitive-echo|private-content/u, `escaped ${label}`);
  }
});

test('认证头、Cookie、常见 token、URL 凭据与纯 base64 不输出', () => {
  const labels = ['Authorization', 'Proxy-Authorization', 'Cookie', 'Set-Cookie', 'set_cookie', 'apiKey', 'x-api-key', 'token', 'accessToken', 'refresh_token', 'authToken', 'session_token', 'auth', 'password', 'client_secret', 'secretKey', 'key'];
  for (const label of labels) {
    const detail = diagnostics.formatSafeErrorDiagnostics(`HTTP 401; "${label}": "secret-value"\nwrapped-secret-line`);
    assert.doesNotMatch(detail, /secret-value|wrapped-secret-line/u, label);
    assert.match(detail, /已脱敏/u, label);
    assert.doesNotMatch(diagnostics.formatSafeErrorDiagnostics(`错误；${label}:secret-value`), /secret-value/u, `Chinese punctuation ${label}`);
  }
  assert.doesNotMatch(diagnostics.formatSafeErrorDiagnostics('HTTP 401; {"\\u0074oken":"secret-value"}'), /secret-value/u);
  for (const value of [
    'Bearer unlabelled-secret', 'Basic c2VjcmV0LXZhbHVl', 'sk-test-secret-value',
    'eyJheader.encodedpayload.signature', 'data:image/png;base64,SECRETPAYLOAD\nCONTINUATION',
    'A'.repeat(1_000), 'https://user:password@api.example.invalid/private-key/path?any=unknown-token#private-fragment',
  ]) {
    const detail = diagnostics.formatSafeErrorDiagnostics(`failed: ${value}`);
    assert.doesNotMatch(detail, /unlabelled-secret|c2VjcmV0|sk-test-secret|encodedpayload|SECRETPAYLOAD|CONTINUATION|A{128}|password|private-key|unknown-token|private-fragment/u);
  }
});

test('调用方给出的密钥和提示词原文、JSON/URL 编码形式均隐藏', () => {
  const secret = 'test/key with special?characters';
  const prompt = '第一行私人剧情\n第二行 "对白"。';
  for (const value of [secret, encodeURIComponent(secret), prompt, JSON.stringify(prompt).slice(1, -1), encodeURIComponent(prompt)]) {
    const detail = diagnostics.formatSafeErrorDiagnostics(`诊断：${value}`, { knownSecrets: [secret], sensitiveTexts: [prompt] });
    assert.doesNotMatch(detail, /test\/key|test%2Fkey|私人剧情|第一行|%E7%AC%AC/u);
    assert.match(detail, /已脱敏/u);
  }
  const longPrompt = '这是非常长的私人剧情'.repeat(10_000);
  assert.doesNotMatch(diagnostics.formatSafeErrorDiagnostics(`错误：${longPrompt}`, { sensitiveTexts: [longPrompt] }), /私人剧情/u);
  const short = diagnostics.formatSafeErrorDiagnostics({ message: '说明：x7; y8', code: 'x7', route: 'y8' }, { knownSecrets: ['x7'], sensitiveTexts: ['y8'] });
  assert.doesNotMatch(short, /x7|y8/u, 'short secrets are removed from metadata and raw detail too');
  const nearOutputLimit = '错误说明。'.repeat(799) + 'small-secret' + '后文';
  assert.doesNotMatch(diagnostics.formatSafeErrorDiagnostics(nearOutputLimit, { knownSecrets: ['small-secret'] }), /small-secret/u, 'redaction runs before display truncation');
});

test('循环对象、抛异常 getter/toString/toJSON 不被执行或展开', () => {
  let invoked = 0;
  const error: Record<string, unknown> = { status: 500 };
  error.cause = error;
  for (const key of ['message', 'error', 'code', 'route', 'response', 'requestBody']) {
    Object.defineProperty(error, key, { get: () => { invoked += 1; throw new Error('must never run'); } });
  }
  error.toString = () => { invoked += 1; throw new Error('must never stringify'); };
  error.toJSON = () => { invoked += 1; throw new Error('must never serialize'); };
  assert.match(diagnostics.formatSafeErrorDiagnostics(error), /HTTP 状态：500/u);
  assert.equal(invoked, 0);
  const rejectedProxy = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error('blocked'); } });
  assert.doesNotThrow(() => diagnostics.formatSafeErrorDiagnostics(rejectedProxy));
  assert.doesNotThrow(() => diagnostics.formatSafeErrorDiagnostics(undefined));
});

test('超长文本有界，嵌套 cause 不循环、不改变原对象', () => {
  const error = { message: '本地连接失败', cause: { message: '远端附带诊断'.repeat(100_000), status: 502 } };
  const before = structuredClone(error);
  const detail = diagnostics.formatSafeErrorDiagnostics(error);
  assert.ok(detail.length < 5_000);
  assert.match(detail, /HTTP 状态：502/u);
  assert.deepEqual(error, before);
  const payload = `TLS handshake failed; requestBody: ${'私人正文'.repeat(100_000)}`;
  assert.doesNotMatch(diagnostics.formatSafeErrorDiagnostics(payload), /私人正文/u);
});

interface Props { children?: React.ReactNode; [key: string]: any }
type Node = React.ReactElement<Props>;
const nodesOf = (value: React.ReactNode): Node[] => {
  if (Array.isArray(value)) return value.flatMap(nodesOf);
  if (!React.isValidElement<Props>(value)) return [];
  return [value, ...nodesOf(value.props.children)];
};
const textOf = (value: React.ReactNode): string => {
  if (value == null || typeof value === 'boolean') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textOf).join('');
  return React.isValidElement<Props>(value) ? textOf(value.props.children) : '';
};

function harness(initialProps: Props, copy: (text: string) => Promise<boolean> = async () => true) {
  let cursor = 0;
  const slots: any[] = [];
  const effects: Array<() => (() => void) | void> = [];
  const cleanups: Array<() => void> = [];
  let disposed = false;
  let updatesAfterDispose = 0;
  let props = initialProps;
  let tree!: React.ReactElement;
  const copies: string[] = [];
  const hooks = {
    useState: (initial: unknown) => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (value: unknown) => { if (disposed) updatesAfterDispose += 1; slots[index] = value; }]; },
    useRef: (initial: unknown) => { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useEffect: (callback: () => (() => void) | void) => { const index = cursor++; if (!(index in slots)) { slots[index] = true; effects.push(callback); } },
  };
  const source = readFileSync(new URL('../src/components/TaskErrorDetails.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  const fakeRequire = (name: string) => {
    if (name === 'react') return { ...React, ...hooks };
    if (name === '../errorDiagnostics') return diagnostics;
    if (name === '../userFacingError') return userFacing;
    if (name === '../storage') return { copyText: (value: string) => { copies.push(value); return copy(value); } };
    throw new Error(`Unexpected component dependency: ${name}`);
  };
  new Function('require', 'module', 'exports', 'React', compiled)(fakeRequire, module, module.exports, React);
  const Component = module.exports.TaskErrorDetails as (value: Props) => React.ReactElement;
  const render = () => { cursor = 0; tree = Component(props); while (effects.length) { const cleanup = effects.shift()!(); if (cleanup) cleanups.push(cleanup); } return tree; };
  const required = (type: string, label?: string) => {
    const result = nodesOf(tree).find((node) => node.type === type && (label === undefined || textOf(node.props.children) === label));
    assert.ok(result, `missing ${type}: ${label || ''}`);
    return result;
  };
  render();
  return {
    render, required, copies, text: () => textOf(tree), all: () => nodesOf(tree), html: () => renderToStaticMarkup(tree),
    change: (next: Props) => { props = next; render(); },
    dispose: () => { cleanups.forEach((cleanup) => cleanup()); disposed = true; },
    get updatesAfterDispose() { return updatesAfterDispose; },
  };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

await testAsync('默认中文摘要、折叠详情、反复复制只写脱敏剪贴板，不改错误', async () => {
  const error = Object.freeze(Object.assign(new Error('Client network socket disconnected before secure TLS connection was established; secret-key'), { code: 'ECONNRESET', stage: 'image-generation' }));
  const h = harness({ error, knownSecrets: ['secret-key'], className: 'test-host' });
  assert.match(h.required('div').props.className, /test-host/u);
  const summary = h.all().find((node) => node.props.className === 'task-error-summary')!;
  assert.match(textOf(summary), /TLS.*连接/u);
  assert.equal(h.required('details').props.open, undefined, 'native details starts closed');
  assert.equal(h.required('details').props.onToggle, undefined, 'opening has no API or generation side effect');
  h.required('summary', '查看错误详情');
  assert.match(textOf(h.required('pre').props.children), /Client network socket disconnected/u);
  assert.doesNotMatch(h.text(), /secret-key/u);
  for (let count = 0; count < 3; count += 1) {
    h.required('button', '复制错误详情').props.onClick(); await settle(); h.render();
    assert.match(h.text(), /已复制（敏感信息已脱敏）/u);
  }
  assert.equal(h.copies.length, 3);
  assert.equal(new Set(h.copies).size, 1);
  assert.doesNotMatch(h.copies.join('\n'), /secret-key/u);
  assert.match(error.message, /secret-key/u, 'display must not mutate saved diagnostic');
  assert.equal(h.all().filter((node) => node.type === 'button').length, 1, 'no retry or generation action');
  h.dispose();
});

await testAsync('旧H3格式失败显示具体中文原因，原始详情与复制保留技术标记且继续脱敏', async () => {
  const h3Cause = '缺少完整H3官方section、连续[Shot N]或逐镜At切点，或返回了普通六字段时间轴。';
  const raw = `最终视频提示词生成失败：AI已自动重试修复H3格式3次，但返回内容仍不符合官方格式：${h3Cause}本次新结果未保存，原有结果保持不变。`;
  const error = Object.freeze(new Error(`${raw}附加：private-diagnostic-value；认证：Bearer test-credential`));
  const h = harness({ error, knownSecrets: ['test-credential'], sensitiveTexts: ['private-diagnostic-value'] });
  const summary = textOf(h.all().find((node) => node.props.className === 'task-error-summary')!);
  assert.match(summary, /H3格式未完成：缺少官方章节、连续镜头编号或逐镜切点/u);
  assert.match(summary, /本次新结果未保存，原有结果保持不变/u);
  assert.doesNotMatch(summary, /服务返回了未识别|暂时无法确定|private-diagnostic-value|test-credential/u);
  const detail = textOf(h.required('pre').props.children);
  assert.ok(detail.includes(h3Cause), 'technical details retain original H3 protocol labels instead of replacing the raw diagnostic');
  assert.doesNotMatch(h.text(), /private-diagnostic-value|test-credential/u);
  h.required('button', '复制错误详情').props.onClick(); await settle(); h.render();
  assert.equal(h.copies[0], detail);
  assert.doesNotMatch(h.copies[0], /private-diagnostic-value|test-credential/u);
  assert.equal(error.message, `${raw}附加：private-diagnostic-value；认证：Bearer test-credential`);
  h.dispose();
});

await testAsync('语义分段结构诊断保留重试次数、字段原因与数量证据，摘要详情及复制继续脱敏', async () => {
  const prefix = 'AI 语义分段结构无效：AI 分段已自动重试 3 次（共 4 次请求），最后仍未取得完整结果。；';
  for (const cause of [
    'fitStatus 枚举无效',
    '$.fitStatus 必须是字符串（收到数组）；允许值为 comfortable（宽裕）、balanced（适中）、compressed（紧凑）、insufficient（不足），必须仅返回一个英文状态，解释写入 reason',
    'segmentCount 必须等于 segments 数量',
    '旧格式段数字段 segmentCount 必须为 1–900 的整数；新格式无需填写该字段',
    '分段数量不一致：AI 声明 8 段，实际返回 6 段（segmentCount 与 segments 数量不一致）',
    '固定总时长需要 6 段（90 秒 ÷ 每段 15 秒），实际返回 5 段',
    'segments 必须是非空数组',
    '第 1 段缺少 content 正文',
  ]) {
    const raw = `${prefix}${cause}。`;
    const error = Object.freeze(new Error(`${raw}附加：private-semantic-source；认证：Bearer semantic-credential；responseBody: {"story":"private-response-body"}`));
    const before = error.message;
    const h = harness({ error, knownSecrets: ['semantic-credential'], sensitiveTexts: ['private-semantic-source'] });
    const summary = textOf(h.all().find((node) => node.props.className === 'task-error-summary')!);
    assert.ok(summary.includes(raw), 'the summary preserves the complete known semantic diagnosis');
    assert.doesNotMatch(summary, /服务返回了未识别|暂时无法确定/u);
    assert.match(summary, /重试 3 次（共 4 次请求）/u);
    assert.equal(h.required('details').props.open, undefined, 'a precise cause does not open technical details or start work');
    assert.equal(h.all().filter((node) => node.type === 'button').length, 1, 'only the existing local copy action remains');
    const detail = textOf(h.required('pre').props.children);
    assert.ok(detail.includes(raw), 'technical details still retain the original protocol field and retry count');
    assert.doesNotMatch(h.text(), /private-semantic-source|semantic-credential|private-response-body/u);
    h.required('button', '复制错误详情').props.onClick(); await settle(); h.render();
    assert.equal(h.copies[0], detail);
    assert.doesNotMatch(h.copies[0], /private-semantic-source|semantic-credential|private-response-body/u);
    assert.equal(error.message, before, 'local display and copy never rewrite the saved diagnostic');
    h.dispose();
  }
});

await testAsync('复制失败 inline 提示，不泄漏剪贴板异常、不自动重试', async () => {
  for (const copy of [async () => false, async () => { throw new Error('secret clipboard error'); }]) {
    const h = harness({ error: 'Unrecognized vendor failure' }, copy);
    h.required('button', '复制错误详情').props.onClick(); await settle(); h.render();
    assert.match(h.text(), /复制失败，请选中详情手动复制/u);
    assert.doesNotMatch(h.text(), /secret clipboard error/u);
    assert.equal(h.copies.length, 1);
    h.dispose();
  }
});

await testAsync('独立主因摘要同样脱敏，技术详情与复制仍保留完整诊断', async () => {
  const error = Object.freeze({ message: 'api queue limit reached, please retry later\n原因：Untranslated node diagnostic; private-node-prompt', code: 'RH_QUEUE_FULL', status: 429 });
  const summaryError = Object.freeze({ message: '接口并发生成数量已达上限；附加：summary-secret；private-summary-prompt', code: 'RH_QUEUE_FULL', status: 429 });
  const h = harness({ error, summaryError, knownSecrets: ['summary-secret'], sensitiveTexts: ['private-node-prompt', 'private-summary-prompt'] });
  const summary = textOf(h.all().find((node) => node.props.className === 'task-error-summary')!);
  assert.match(summary, /接口并发生成数量已达上限/u);
  assert.match(summary, /HTTP 429/u); assert.match(summary, /RH_QUEUE_FULL/u);
  assert.doesNotMatch(summary, /Untranslated|未识别|summary-secret|private-summary-prompt/u);
  assert.doesNotMatch(h.text(), /summary-secret|private-node-prompt|private-summary-prompt/u);
  const detail = textOf(h.required('pre').props.children);
  assert.match(detail, /Untranslated node diagnostic/u);
  h.required('button', '复制错误详情').props.onClick(); await settle(); h.render();
  assert.equal(h.copies[0], detail, 'optional summary never narrows or replaces the copied technical details');
  assert.match(error.message, /private-node-prompt/u); assert.match(summaryError.message, /summary-secret/u);
  h.dispose();
});

await testAsync('原始 HTML 只当文本渲染，错误变更后不沿用旧复制状态', async () => {
  const h = harness({ error: '生成失败：<img src=x onerror="evil()"><script>evil()</script>' });
  assert.match(h.html(), /&lt;img/u);
  assert.doesNotMatch(h.html(), /<img|<script/u);
  assert.equal(h.all().some((node) => node.props.dangerouslySetInnerHTML), false);
  h.required('button', '复制错误详情').props.onClick(); await settle(); h.render();
  assert.match(h.text(), /已复制/u);
  h.change({ error: 'A second unknown provider error' });
  assert.doesNotMatch(h.text(), /已复制/u);
  h.dispose();
});

await testAsync('复制中禁用重复操作，卸载后异步结果不更新组件', async () => {
  let resolve!: (value: boolean) => void;
  const pending = new Promise<boolean>((done) => { resolve = done; });
  const h = harness({ error: new Error('TLS failed') }, () => pending);
  const originalButton = h.required('button', '复制错误详情');
  originalButton.props.onClick();
  originalButton.props.onClick();
  assert.equal(h.copies.length, 1, 'same-render rapid clicks are guarded before React rerenders');
  h.render();
  assert.equal(h.required('button', '复制中…').props.disabled, true);
  h.required('button', '复制中…').props.onClick();
  assert.equal(h.copies.length, 1);
  h.dispose(); resolve(true); await settle();
  assert.equal(h.updatesAfterDispose, 0);
});

await testAsync('旧错误 A 的迟到复制结果不能覆盖错误 B 已完成或正在复制的状态', async () => {
  for (const firstResult of [true, false]) {
    const resolvers: Array<(value: boolean) => void> = [];
    const h = harness({ error: 'Unknown error A' }, () => new Promise<boolean>((done) => { resolvers.push(done); }));
    const staleButton = h.required('button', '复制错误详情');
    staleButton.props.onClick(); h.render();
    h.change({ error: 'Unknown error B' });
    staleButton.props.onClick();
    assert.equal(h.copies.length, 1, 'a handler from an old error cannot copy it after props changed');
    h.required('button', '复制错误详情').props.onClick(); h.render();
    assert.equal(h.copies.length, 2);
    resolvers[1](firstResult); await settle(); h.render();
    const currentText = h.text();
    assert.match(currentText, firstResult ? /已复制/u : /复制失败/u);
    resolvers[0](!firstResult); await settle(); h.render();
    assert.equal(h.text(), currentText, 'late A completion must not clear or replace B feedback');
    h.dispose();
  }
});

await testAsync('切换错误后旧复制完成，不会让返回旧错误的按钮永久卡在复制中', async () => {
  let resolve!: (value: boolean) => void;
  const h = harness({ error: 'Unknown error A' }, () => new Promise<boolean>((done) => { resolve = done; }));
  h.required('button', '复制错误详情').props.onClick(); h.render();
  h.change({ error: 'Unknown error B' });
  resolve(true); await settle(); h.render();
  h.change({ error: 'Unknown error A' });
  assert.equal(h.required('button', '复制错误详情').props.disabled, false);
  assert.doesNotMatch(h.text(), /复制中/u);
  h.dispose();
});

console.log(`task error details: ${groups} groups passed (mocked clipboard; no API requests)`);
