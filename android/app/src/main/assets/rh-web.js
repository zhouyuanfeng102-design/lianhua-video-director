(() => {
if (window.__lianhuaRh) return;
const readSession = () => {
    const ownText = (element) => [...element.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent || '').join('').replace(/\s+/gu, ' ').trim();
    const header = document.querySelector('.header-right') || document.querySelector('.common-header') || document.body;
    const login = [...header.querySelectorAll('button, a, span, div')].some((element) => ownText(element) === '登录/注册' || (element.textContent || '').trim() === '登录/注册');
    const snippets = [];
    const push = (value) => {
      const text = String(value || '').replace(/\s+/gu, ' ').trim();
      if (text && text.length <= 48 && !snippets.includes(text)) snippets.push(text);
    };
    for (const element of header.querySelectorAll('[title], [aria-label]')) {
      push(element.getAttribute('title'));
      push(element.getAttribute('aria-label'));
    }
    for (const element of header.querySelectorAll('span, div, button, a, p')) push(ownText(element));
    const kindOf = (value) => {
      if (/过渡/u.test(value) && /RH/iu.test(value)) return 'transition';
      if (/积分|credits/iu.test(value)) return 'points';
      if (/^RH\s*币|^RH\s*coins/iu.test(value)) return 'legacy';
      if (/钱包|\$|美元|USD/iu.test(value)) return 'wallet';
      return '';
    };
    const first = (kind) => {
      const matches = snippets.filter((value) => kindOf(value) === kind);
      return matches.find((value) => /\d/u.test(value)) || matches[0] || '';
    };
    const points = first('points');
    const transition = first('transition');
    const legacy = first('legacy');
    const wallet = first('wallet');
    const coins = points || transition ? [points, transition].filter(Boolean).join(' · ') : legacy;
    const nickFrom = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 5) return '';
      if (typeof value.nickName === 'string' && value.nickName.trim()) return value.nickName.trim();
      for (const child of Object.values(value)) {
        if (!child || typeof child !== 'object') continue;
        const found = nickFrom(child, depth + 1);
        if (found) return found;
      }
      return '';
    };
    let displayName = '';
    try {
      const raw = localStorage.getItem('rh-login-user-info');
      if (raw) displayName = nickFrom(JSON.parse(raw));
    } catch { /* The login record is optional. */ }
    if (!displayName) {
      const named = header.querySelector('[class*="nick"], [class*="user-name"], [class*="userName"]');
      displayName = named ? ownText(named) || (named.textContent || '').trim() : '';
    }
    return { loggedIn: !login, displayName, coins, wallet };
  };
const readForm = () => {
    const side = document.querySelector('.ai-side');
    if (!side) return { fields: [], instance: '', estimate: '' };
    const fields = [];
    let image = 0;
    let audio = 0;
    let lora = 0;
    let text = 0;
    let number = 0;
    let boolean = 0;
    for (const label of side.querySelectorAll('.media-group-item-label')) {
      const name = (label.getAttribute('title') || label.textContent || '').trim();
      if (!name) continue;
      const isAudio = /^audio/iu.test(name);
      if (isAudio) audio += 1;
      else image += 1;
      fields.push({ key: isAudio ? `audio:${audio}` : `image:${image}`, label: name, kind: isAudio ? 'audio' : 'image', value: '' });
    }
    for (const title of side.querySelectorAll('.plane-top .title')) {
      const name = (title.getAttribute('title') || title.textContent || '').trim();
      if (!name || name === '上传图片' || name === '上传音频') continue;
      const plane = title.closest('.item-plane, .side-plane') || title.parentElement?.parentElement;
      if (!plane) continue;
      if (/^lora_name$/iu.test(name)) {
        lora += 1;
        const shown = [...plane.querySelectorAll('.ant-select-selection-item, .ant-select-selection-search-input')]
          .map((node) => (node.value || node.textContent || '').trim())
          .find((value) => value && !/strength/iu.test(value)) || '';
        fields.push({ key: `lora:${lora}:name`, label: `lora_name ${lora}`, kind: 'text', value: shown });
        const strength = plane.querySelector('input[type="number"]');
        if (strength) fields.push({ key: `lora:${lora}:strength`, label: `strength_model ${lora}`, kind: 'number', value: strength.value });
        continue;
      }
      const toggle = plane.querySelector('[role="switch"]');
      const area = plane.querySelector('textarea');
      const numeric = plane.querySelector('input[type="number"]');
      const selected = plane.querySelector('.ant-select-selection-item');
      if (toggle) {
        boolean += 1;
        const key = name === '自动提示词' ? 'boolean:auto-prompt' : name.includes('输出') ? 'boolean:output' : `boolean:${boolean}`;
        fields.push({ key, label: name, kind: 'boolean', value: toggle.getAttribute('aria-checked') === 'true' });
      } else if (area) {
        text += 1;
        const key = name === '提示词' ? 'text:prompt' : /触发/u.test(name) ? 'text:trigger' : `text:${text}`;
        fields.push({ key, label: name, kind: 'text', value: area.value });
      } else if (numeric && !/aspect|比例/iu.test(name)) {
        number += 1;
        const key = /时长/u.test(name) ? 'number:duration' : /像素|megapixel/iu.test(name) ? 'number:megapixels' : `number:${number}`;
        const numericValue = Number(numeric.value);
        fields.push({ key, label: name, kind: 'number', value: Number.isFinite(numericValue) ? numericValue : numeric.value });
      } else if (selected || /aspect|比例/iu.test(name)) {
        const aspect = /aspect|比例/iu.test(name);
        fields.push({ key: aspect ? 'select:aspect' : `select:${name}`, label: name, kind: 'select', value: (selected?.textContent || '').trim(), options: [] });
      }
    }
    const instance = (document.querySelector('.run-mode-current')?.textContent || '').trim();
    const pageText = document.body.innerText;
    const estimate = (pageText.match(/≈\s*[\d,.]+\s*RH币/u) || pageText.match(/≈\s*[\d,.]+\s*积分/u) || pageText.match(/≈\s*[\d,.]+\s*过渡\s*RH\s*币/u) || [])[0] || '';
    const heading = document.querySelector('h1.ai-title');
    let name = (heading?.getAttribute('title') || heading?.textContent || '').replace(/\s+/g, ' ').trim();
    if (!name) name = document.title.replace(/\s*[-|–—]\s*RunningHub\b.*/i, '').trim();
    if (!name || /^RunningHub$/i.test(name)) name = '';
    return { fields, instance, estimate, ...(name ? { name } : {}) };
  };
const finishedOutput = async ({ webappId, taskId }) => {
    const token = localStorage.getItem('Rh-Accesstoken') || '';
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const records = [];
    let fromId = '';
    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
      const response = await fetch('/api/output/v2/history', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ size: 20, current: 1, taskType: ['WORKFLOW', 'WEBAPP'], webappId, fromId }),
      });
      if (!response.ok) return null;
      const body = await response.json();
      const data = body?.data ?? body;
      const list = Array.isArray(data) ? data : (data?.records || data?.list || []);
      if (!Array.isArray(list) || !list.length) break;
      records.push(...list);
      const found = list.find((item) => String(item?.taskId) === String(taskId));
      if (found) {
        const status = String(found.taskStatus || '').toUpperCase();
        return {
          seen: true,
          done: status === 'SUCCESS' || status === 'SUCCEED' || status === 'FINISHED',
          failed: status === 'FAILED' || status === 'ERROR',
          fileUrl: found.fileUrl || found.url || found.filePreviewUrl || '',
        };
      }
      if (list.length < 20) break;
      fromId = String(list[list.length - 1]?.taskId || '');
      if (!fromId) break;
    }
    return { seen: records.length > 0, done: false, failed: false, fileUrl: '' };
  };
// Native mobile page operations reuse the desktop site's selectors and values.
// Waiting below only observes DOM/network completion; it never clicks run again.
const waitFor = async (read, timeout = 20000) => {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - start >= timeout) throw new Error('网页内容尚未就绪，请回到网页查看。');
    await new Promise(resolve => setTimeout(resolve, 150));
  }
};
const text = node => (node?.textContent || '').replace(/\s+/g, ' ').trim();
const findRunButton = () => {
  const wanted = new Set(['立即运行', 'Run Now']);
  const nodes = [...document.querySelectorAll('button, [role="button"], .run-cell-main')];
  return nodes.find((node) => wanted.has(text(node)) || (node.classList?.contains('run-cell-main') && /立即运行|Run Now/.test(node.innerText || '')));
};
const exact = (nodes, label) => [...nodes].find(node => text(node) === label);
const change = (input, value) => {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, String(value));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.blur();
};
const planeFor = assignment => {
  const titles = [...document.querySelectorAll('.ai-side .title')];
  const lora = /^lora:(\d+):/.exec(assignment.key);
  const title = lora ? titles.filter(node => text(node) === 'lora_name')[Number(lora[1]) - 1]
    : titles.find(node => text(node) === assignment.label.replace(/ \d+$/, ''));
  const plane = title?.closest('.item-plane, .side-plane');
  if (!plane) throw new Error(`网页上找不到 ${assignment.label}`);
  return plane;
};
const choose = async (trigger, value) => {
  if (!trigger) throw new Error('网页选项尚未显示。');
  trigger.click();
  const option = await waitFor(() => exact(document.querySelectorAll('.ant-select-item-option-content, [role="option"], .run-mode-item'), String(value)), 8000);
  option.click();
};
const openDropdowns = () => [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')]
  .filter(node => node.getClientRects().length > 0);
const afterDropdownRender = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function readOpenOptions() {
  const dropdown = openDropdowns().at(-1);
  if (!dropdown) return [];
  const seen = [];
  // Same bounded virtual-list traversal as the desktop page adapter.
  for (let step = 0; step < 12; step += 1) {
    for (const option of dropdown.querySelectorAll('.ant-select-item-option-content')) {
      const value = (option.textContent || '').trim();
      if (value && !seen.includes(value)) seen.push(value);
    }
    const holder = dropdown.querySelector('.rc-virtual-list-holder');
    if (!holder) break;
    const before = holder.scrollTop;
    holder.scrollTop = before + holder.clientHeight;
    if (holder.scrollTop === before) break;
    await afterDropdownRender();
  }
  return seen;
}
async function readSelectOptions(fields) {
  const found = [];
  const planes = [...document.querySelectorAll('.ai-side .item-plane, .ai-side .side-plane')]
    .filter(plane => plane.querySelector('.ant-select'));
  for (const plane of planes) {
    const title = plane.querySelector('.plane-top > .title');
    const label = (title?.getAttribute('title') || title?.textContent || '').trim();
    // LoRA keeps its existing resource picker and dedicated name/strength keys.
    if (!label || !fields.some(field => field.kind === 'select' && field.label === label)) continue;
    const trigger = plane.querySelector('.ant-select');
    trigger.click();
    await waitFor(() => openDropdowns().some(dropdown => dropdown.querySelector('.ant-select-item-option-content')), 2500).catch(() => null);
    const options = await readOpenOptions();
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : trigger;
    focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    // Some site controls only handle a click to close their open popup.
    if (openDropdowns().length) trigger.click();
    found.push({ label, options });
  }
  return found;
}
async function fillControl(assignment) {
  if (assignment.kind === 'image' || assignment.kind === 'audio') {
    const items = [...document.querySelectorAll('.ai-side .media-group-item')];
    const item = items.find(node => text(node.querySelector('.media-group-item-label')) === assignment.label);
    if (!item) throw new Error(`网页上找不到 ${assignment.label}`);
    const remove = item.querySelector('.removeIcon, .ai-audio-upload__close');
    if (remove) { remove.click(); await waitFor(() => !item.querySelector('.removeIcon, .ai-audio-upload__close'), 8000); }
    if (!assignment.value) return;
    const input = item.querySelector('input[type="file"]');
    if (!input) throw new Error(`${assignment.label} 的网页文件入口没有出现，请在网页选择后再操作。`);
    const match = String(assignment.value).match(/^data:([^;,]+);base64,(.*)$/);
    if (!match) throw new Error('本次网页参考素材未读取。');
    const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], assignment.fileName || `reference.${match[1].split('/')[1]}`, { type: match[1] }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => item.querySelector('.removeIcon, .ai-audio-upload__close, .history-medium'), 60000);
    return;
  }
  const plane = planeFor(assignment);
  if (/^lora:\d+:name$/.test(assignment.key)) {
    const current = plane.querySelector('.mode-title');
    const normalize = v => String(v).trim().toLowerCase().replace(/\.safetensors$/, '');
    if (!assignment.value || normalize(current?.title || text(current)) === normalize(assignment.value)) return;
    plane.querySelector('.change-btn')?.click();
    const dialog = await waitFor(() => document.querySelector('.resource-select-modal'), 8000);
    const input = dialog.querySelector('input[placeholder="搜索模型"]');
    if (!input) throw new Error('网页模型搜索入口未显示。');
    change(input, String(assignment.value).replace(/\.safetensors$/i, ''));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    const title = await waitFor(() => [...dialog.querySelectorAll('[title]')].find(node => normalize(node.title) === normalize(assignment.value)), 12000);
    let node = title;
    while (node && node !== dialog) {
      const use = exact(node.querySelectorAll('button'), '立即使用');
      if (use) { use.click(); await waitFor(() => !document.body.contains(dialog), 8000); return; }
      node = node.parentElement;
    }
    throw new Error(`网页模型列表里没有 ${assignment.value} 的使用入口。`);
  }
  if (/^lora:\d+:strength$/.test(assignment.key)) {
    let sibling = plane.nextElementSibling;
    while (sibling && !sibling.querySelector('input[type="number"]')) sibling = sibling.nextElementSibling;
    const input = sibling?.querySelector('input[type="number"]');
    if (!input) throw new Error('网页 LoRA 强度输入框未显示。');
    change(input, assignment.value); return;
  }
  if (assignment.kind === 'boolean') {
    const toggle = plane.querySelector('[role="switch"]');
    if (!toggle) throw new Error(`网页上找不到 ${assignment.label} 开关。`);
    if ((toggle.getAttribute('aria-checked') === 'true') !== Boolean(assignment.value)) toggle.click();
    return;
  }
  if (assignment.kind === 'select') return choose(plane.querySelector('.ant-select'), assignment.value);
  const input = plane.querySelector(assignment.kind === 'number' ? 'input[type="number"]' : 'textarea');
  if (input) { change(input, assignment.value); return; }
  if (plane.querySelector('.ant-select')) return choose(plane.querySelector('.ant-select'), assignment.value);
  throw new Error(`网页上的 ${assignment.label} 不是可填写的输入框。`);
}
const captures = [];
const capture = body => {
  const id = body?.data?.taskId || body?.taskId;
  if (id) captures.push(String(id));
};
const originalFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const response = await originalFetch(...args);
  const method = String(args[1]?.method || (args[0] instanceof Request ? args[0].method : 'GET')).toUpperCase();
  if (method === 'POST') response.clone().json().then(capture).catch(() => {});
  return response;
};
const xhrOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, ...args) { this.__lhPost = String(method).toUpperCase() === 'POST'; return xhrOpen.call(this, method, ...args); };
const xhrSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function(...args) {
  if (this.__lhPost) this.addEventListener('load', () => { try { capture(this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); } catch {} }, { once: true });
  return xhrSend.apply(this, args);
};
const operations = {
  session: () => readSession(),
  read: async () => {
    await waitFor(() => document.querySelector('.ai-side .media-group-item-label, .ai-side textarea, .ai-side .ant-select, .ai-side input[type="number"], .ai-side [role="switch"]'));
    const form = readForm();
    const lists = await readSelectOptions(form.fields);
    for (const field of form.fields) {
      if (field.kind !== 'select') continue;
      const match = lists.find(item => item.label === field.label);
      const options = match?.options?.length ? match.options : [];
      const current = String(field.value || '').trim();
      field.options = current && !options.includes(current) ? [current, ...options] : options;
    }
    return form;
  },
  prepare: async body => {
    await waitFor(() => document.querySelector('.ai-side textarea, .ai-side .media-group-item'));
    const session = readSession();
    if (!session.loggedIn) throw new Error('请先在此登录窗口完成 RunningHub 登录。');
    const fields = body.fields || [];
    for (const field of fields.filter(item => !['image', 'audio'].includes(item.kind))) await fillControl(field);
    for (const field of fields.filter(item => ['image', 'audio'].includes(item.kind))) await fillControl(field);
    const current = document.querySelector('.run-mode-current');
    if (body.instance && text(current) !== body.instance) await choose(current, body.instance);
    const run = findRunButton();
    let region = '';
    let regionNode = run;
    for (let depth = 0; regionNode && depth < 8; depth += 1) {
      const sample = (regionNode.innerText || '').replace(/\s+/g, ' ');
      if (/≈\s*[\d,.]+\s*RH币|≈\s*[\d,.]+\s*积分|≈\s*[\d,.]+\s*过渡\s*RH\s*币|费用以实际用量结算/.test(sample)) { region = sample; break; }
      regionNode = regionNode.parentElement;
    }
    const source = `${region} ${document.body.innerText}`;
    const legacy = source.match(/≈\s*[\d,.]+\s*RH币/);
    const points = source.match(/≈\s*[\d,.]+\s*积分/);
    const transition = source.match(/≈\s*[\d,.]+\s*过渡\s*RH\s*币/);
    const quote = (legacy || points || transition || [])[0] || '';
    return { quote };
  },
  submit: async body => {
    const key = `lianhua-task:${body.client_id}`;
    const saved = localStorage.getItem(key);
    if (saved) return JSON.parse(saved);
    const run = findRunButton();
    if (!run) throw new Error('网页上还没有「立即运行」，这次没有提交。');
    // Persist after the button is found, immediately before the click.
    const marker = { status: 'submission_unknown', message: '已交到网页，等待任务编号。' };
    localStorage.setItem(key, JSON.stringify(marker));
    captures.length = 0;
    run.click();
    const id = await waitFor(() => captures[0], 20000).catch(() => '');
    const result = id ? { status: 'running', upstream_task_id: id, message: `网页任务 ${id} 已提交。` }
      : { status: 'submission_unknown', message: '已点击运行但未取得任务编号，请在网页“我的生成”核对。' };
    localStorage.setItem(key, JSON.stringify(result));
    return result;
  },
  recover: body => {
    const saved = localStorage.getItem(`lianhua-task:${body.client_id}`);
    return saved ? JSON.parse(saved) : {};
  },
  output: async body => {
    const output = await finishedOutput({ webappId: body.webappId, taskId: body.taskId });
    // Credentials stay inside the isolated native page, only used for this file.
    return { ...(output || {}), token: localStorage.getItem('Rh-Accesstoken') || '' };
  }
};
window.__lianhuaRh = { operations, results: Object.create(null) };
})();
