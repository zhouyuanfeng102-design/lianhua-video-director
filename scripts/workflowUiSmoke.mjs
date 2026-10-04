import fs from 'node:fs';
import path from 'node:path';
import { updateLogEntries } from '../src/updateLog.ts';

const packageInfo = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
// Keep the complete source order instead of maintaining a second release list.
const expectedUpdateLogVersions = updateLogEntries.map(({ version }) => version);
const expectedUpdateLogCurrentVersion = String(packageInfo.version || '').trim();
if (!expectedUpdateLogVersions.length || expectedUpdateLogVersions[0] !== expectedUpdateLogCurrentVersion) {
  throw new Error(`Update log must begin with package version ${expectedUpdateLogCurrentVersion || 'missing'}; received ${expectedUpdateLogVersions[0] || 'no entries'}`);
}

const qaTextStorageKey = 'lianhua_video_director_state_v22';
const qaMockApiKey = 'qa-mock-api-key-never-copy';

const configureQaTextApiState = (rawState, apiBaseUrl, apiKey = '') => {
  if (!rawState) throw new Error('QA state was not persisted before enabling the text API');
  const state = JSON.parse(rawState);
  if (!state?.settings) throw new Error('QA state has no settings section');
  state.settings.textApi = {
    ...state.settings.textApi,
    enabled: true,
    provider: 'openai_compatible',
    baseUrl: apiBaseUrl,
    apiKey,
    model: 'qa-model',
  };
  return JSON.stringify(state);
};

const qaMessageContent = (payload, role) => (
  Array.isArray(payload?.messages)
    ? payload.messages
      .filter((message) => message?.role === role && typeof message?.content === 'string')
      .map((message) => message.content)
      .join('\n')
    : ''
);

// The current generation path translates the persisted MiniMax H3 official
// draft, whose later cuts use `At MM:SS.mmm`; keep the legacy Chinese form for
// compatibility with older fixtures too.
const QA_TRANSLATION_TIME_PATTERN = /(?:【\s*\d+(?:\.\d+)?s\s*[-–—~～至]\s*\d+(?:\.\d+)?s\s*】|\bAt\s+\d{2}:\d{2}\.\d{3}\b)/gu;
const QA_TRANSLATION_ENTITY_PATTERN = /__LH_ENTITY_\d{3}__/gu;

const qaOccurrenceCounts = (values) => values.reduce((counts, value) => {
  counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}, new Map());

const qaEnglishTranslationResponse = (userPrompt) => {
  const source = String(userPrompt || '').trim();
  const sourceTimes = source.match(QA_TRANSLATION_TIME_PATTERN) || [];
  const hasH3ShotStructure = /(?:^|\n)(?:integrated_multimodal_description|detailed_description):/mu.test(source)
    || /__LH_H3_(?:SECTION|CUT|TAG)_\d{3}__/u.test(source);
  if (!sourceTimes.length && !hasH3ShotStructure) {
    throw new Error('QA translator request is missing storyboard timestamps');
  }

  let timeIndex = 0;
  const protectedTimes = source.replace(
    QA_TRANSLATION_TIME_PATTERN,
    () => `__LH_TIME_${String(++timeIndex).padStart(3, '0')}__`,
  );
  const replacements = [
    [/主体\s*[:：]/gu, 'Subject:'],
    [/空间\s*[:：]/gu, 'Space:'],
    [/光影\s*[:：]/gu, 'Lighting:'],
    [/镜头\s*[:：]/gu, 'Camera:'],
    [/动作\s*[:：]/gu, 'Action:'],
    [/台词\s*[:：]/gu, 'Dialogue:'],
    [/音效\s*[:：]/gu, 'Sound:'],
    [/环境层\s*-/gu, 'ambient layer-'],
    [/动作层\s*-/gu, 'action layer-'],
    [/情绪层\s*-/gu, 'emotional layer-'],
    [/无/gu, 'None'],
  ];
  const translatedBody = replacements.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    protectedTimes,
  )
    .replace(/[\p{Script=Han}]+/gu, 'translated')
    .replace(/；/gu, '; ')
    .replace(/，/gu, ', ')
    .replace(/。/gu, '.')
    .replace(/（/gu, ' (')
    .replace(/）/gu, ') ');
  const translated = sourceTimes.reduce(
    (value, time, index) => value.replace(
      `__LH_TIME_${String(index + 1).padStart(3, '0')}__`,
      time,
    ),
    translatedBody,
  );

  const translatedTimes = translated.match(QA_TRANSLATION_TIME_PATTERN) || [];
  if (JSON.stringify(translatedTimes) !== JSON.stringify(sourceTimes)) {
    throw new Error('QA translator changed storyboard timestamps');
  }
  const sourceEntityCounts = qaOccurrenceCounts(source.match(QA_TRANSLATION_ENTITY_PATTERN) || []);
  const translatedEntityCounts = qaOccurrenceCounts(translated.match(QA_TRANSLATION_ENTITY_PATTERN) || []);
  for (const [token, count] of sourceEntityCounts) {
    if (translatedEntityCounts.get(token) !== count) {
      throw new Error(`QA translator changed protected entity ${token}`);
    }
  }
  if (sourceEntityCounts.size !== translatedEntityCounts.size) {
    throw new Error('QA translator added a protected entity');
  }
  return translated;
};

const qaTaggedJson = (source, tag) => {
  const match = String(source || '').match(
    new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'),
  );
  if (!match) throw new Error(`QA text request is missing ${tag}`);
  return JSON.parse(match[1]);
};

const qaConvertedActionStages = [
  (subject) => `${subject}跨过门槛并停在烛光边缘`,
  (subject) => `${subject}接住信封并翻转染血封口`,
  (subject) => `${subject}侧耳转向门扇并握紧剑柄`,
  (subject) => `${subject}盯住门缝并吹灭烛火`,
];

const qaConvertedTimelineResponse = (userPrompt) => {
  const conversionData = qaTaggedJson(userPrompt, 'video_conversion_data');
  const evidence = Array.isArray(conversionData?.shotEvidence)
    ? conversionData.shotEvidence
    : [];
  if (!evidence.length) throw new Error('QA converter request is missing shot evidence');
  return evidence.map((shot, index) => {
    const draft = String(shot?.localStructureDraft || '').trim();
    const exactTimeLabel = String(shot?.exactTimeLabel || '').trim();
    const subject = String(shot?.allowedSubjects?.[0] || '').replace(/^@/u, '').trim();
    if (!draft || !exactTimeLabel || !subject) {
      throw new Error(`QA converter evidence ${index + 1} is incomplete`);
    }
    const timelineDraft = /^【[^】]+】/u.test(draft)
      ? draft.replace(/^【[^】]+】/u, exactTimeLabel)
      : '';
    if (!timelineDraft) throw new Error(`QA converter evidence ${index + 1} has no time header`);
    const shotNumber = Number.isInteger(shot?.shot) && shot.shot > 0
      ? shot.shot
      : index + 1;
    const actionFactory = qaConvertedActionStages[shotNumber - 1]
      || ((stableSubject) => `${stableSubject}移向第${shotNumber}镜构图焦点并稳定姿态`);
    const converted = timelineDraft.replace(
      /正在\s*\[[^\]]*\]/u,
      `正在 [${actionFactory(subject)}]`,
    );
    if (converted === timelineDraft) {
      throw new Error(`QA converter evidence ${index + 1} has no replaceable action chain`);
    }
    return converted;
  }).join('\n');
};

const qaShotRecommendationResponse = (userPrompt) => {
  const planningData = qaTaggedJson(userPrompt, 'storyboard_planning_data');
  const sourceStory = String(planningData?.sourceStory || '').trim();
  const durationSec = Number(planningData?.durationSec);
  if (!sourceStory || !Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error('QA AI storyboard request is missing sourceStory or durationSec');
  }
  const sourceUnits = sourceStory.match(/[^。！？；]+[。！？；]?/gu)?.filter(Boolean)
    || [sourceStory];
  const requestedShotCount = Number(planningData?.requiredShotCount);
  const shotCount = Number.isInteger(requestedShotCount) && requestedShotCount > 0
    ? Math.min(requestedShotCount, sourceUnits.length)
    : Math.min(2, sourceUnits.length);
  const groups = Array.from({ length: shotCount }, (_, index) => {
    const start = Math.floor(index * sourceUnits.length / shotCount);
    const end = Math.floor((index + 1) * sourceUnits.length / shotCount);
    return sourceUnits.slice(start, Math.max(start + 1, end)).join('').trim();
  });
  const boundaries = Array.from({ length: shotCount + 1 }, (_, index) => (
    index === shotCount
      ? durationSec
      : Number((durationSec * index / shotCount).toFixed(2))
  ));
  return JSON.stringify({
    reason: 'QA text model owns the complete shot plan',
    breakdown: ['model shot count', 'model timeline boundaries', 'model source assignment'],
    shots: groups.map((sourceExcerpt, index) => ({
      startSec: boundaries[index],
      endSec: boundaries[index + 1],
      sourceExcerpt,
      purpose: `AI 规划第 ${index + 1} 镜叙事目的`,
      subject: '可见主体',
      action: `可见主体完成第 ${index + 1} 镜动作并留下结果`,
      camera: `AI 规划第 ${index + 1} 镜景别与运镜`,
      transition: index === 0 ? '从环境建立进入' : '沿动作结果切换',
      lighting: '保持场景光向与色温连续',
      sound: '环境声与动作声同步',
      result: `第 ${index + 1} 镜末状态清晰可见`,
    })),
  });
};

const qaTextRequestKind = (payload) => {
  const systemPrompt = qaMessageContent(payload, 'system');
  if (systemPrompt.includes('智能导演分类器')) return 'director';
  if (systemPrompt.includes('<video_conversion_core_task>')) return 'converter';
  if (systemPrompt.includes('视频分镜规划器')) return 'shot-recommendation';
  if (systemPrompt.includes('专业的视频生成提示词翻译器')) return 'translator';
  return 'unexpected';
};

const qaTextResponseContent = (callKind, payload) => {
  const userPrompt = qaMessageContent(payload, 'user');
  if (callKind === 'director') {
    return JSON.stringify({ mode: 'narrative', reason: 'QA smart-director decision' });
  }
  if (callKind === 'shot-recommendation') return qaShotRecommendationResponse(userPrompt);
  if (callKind === 'converter') return qaConvertedTimelineResponse(userPrompt);
  if (callKind === 'translator') return qaEnglishTranslationResponse(userPrompt);
  return '';
};

const port = Number(process.env.CDP_PORT || 9228);
const outputDirectory = process.env.QA_OUTPUT || path.resolve('.qa-workflow');
fs.mkdirSync(outputDirectory, { recursive: true });
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const connectionTimeoutMs = Math.max(1, Number(process.env.CDP_CONNECTION_TIMEOUT_MS) || 10_000);
const targets = await fetch(`http://127.0.0.1:${port}/json/list`, {
  signal: AbortSignal.timeout(connectionTimeoutMs),
}).then((response) => response.json());
const target = targets.find((item) => item.type === 'page' && item.url.includes('127.0.0.1')) || targets.find((item) => item.type === 'page');
if (!target) throw new Error('No browser target');
const appUrl = process.env.APP_URL || target.url;
const qaTextApiBaseUrl = new URL('qa-openai/v1', appUrl).toString();
const socket = new WebSocket(target.webSocketDebuggerUrl);
const commandTimeoutMs = Math.max(1, Number(process.env.CDP_COMMAND_TIMEOUT_MS) || 10_000);
let id = 0;
const pending = new Map();
const consoleErrors = [];
const qaTextRequests = [];
const qaTextMockErrors = [];
const qaStoryboardPlanningPayloads = [];
let qaTextFailureMode = '';
const failPending = (reason) => {
  const error = reason instanceof Error ? reason : new Error(`CDP socket ${String(reason || 'closed')}`);
  for (const handler of pending.values()) {
    clearTimeout(handler.timer);
    handler.reject(error);
  }
  pending.clear();
};
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    const handler = pending.get(message.id); pending.delete(message.id);
    clearTimeout(handler.timer);
    if (message.error) handler.reject(new Error(message.error.message)); else handler.resolve(message.result);
  }
  if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails.text || 'Runtime exception');
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args.map((item) => item.value ?? item.description ?? '').join(' '));
  if (message.method === 'Fetch.requestPaused') {
    void handleQaTextRequest(message.params).catch((error) => {
      qaTextMockErrors.push(error instanceof Error ? error.message : String(error));
    });
  }
});
socket.addEventListener('close', (event) => failPending(event.reason || 'closed'));
socket.addEventListener('error', (event) => failPending(event.message || 'error'));
const command = (method, params = {}) => new Promise((resolve, reject) => {
  if (socket.readyState !== WebSocket.OPEN) {
    reject(new Error('CDP socket is not open'));
    return;
  }
  const commandId = ++id;
  const timer = setTimeout(() => {
    pending.delete(commandId);
    reject(new Error(`CDP command timed out: ${method}`));
  }, commandTimeoutMs);
  pending.set(commandId, { resolve, reject, timer });
  try {
    socket.send(JSON.stringify({ id: commandId, method, params }));
  } catch (error) {
    clearTimeout(timer);
    pending.delete(commandId);
    reject(error);
  }
});
const handleQaTextRequest = async (params) => {
  let callKind = 'unexpected';
  let status = 200;
  let body;
  try {
    const payload = JSON.parse(params.request?.postData || '{}');
    callKind = qaTextRequestKind(payload);
    qaTextRequests.push(callKind);
    if (callKind === 'shot-recommendation') {
      qaStoryboardPlanningPayloads.push(
        qaTaggedJson(qaMessageContent(payload, 'user'), 'storyboard_planning_data'),
      );
    }
    if (qaTextFailureMode === 'auth') {
      status = 401;
      body = { error: { message: 'Authentication Fails (governor)' } };
    } else if (callKind === 'unexpected') {
      status = 500;
      body = { error: { message: 'unexpected QA text request' } };
    } else {
      body = {
        choices: [{ message: { content: qaTextResponseContent(callKind, payload) } }],
      };
    }
  } catch (error) {
    status = 500;
    const message = error instanceof Error ? error.message : 'QA text mock failed';
    qaTextMockErrors.push(`${callKind}: ${message}`);
    body = { error: { message } };
  }
  await command('Fetch.fulfillRequest', {
    requestId: params.requestId,
    responseCode: status,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
    body: Buffer.from(JSON.stringify(body), 'utf8').toString('base64'),
  });
};
const waitForSocketOpen = () => new Promise((resolve, reject) => {
  const cleanup = () => {
    clearTimeout(timer);
    socket.removeEventListener('open', onOpen);
    socket.removeEventListener('error', onError);
  };
  const onOpen = () => { cleanup(); resolve(); };
  const onError = () => { cleanup(); reject(new Error('CDP socket connection failed')); };
  const timer = setTimeout(() => { cleanup(); reject(new Error('CDP socket connection timed out')); }, connectionTimeoutMs);
  socket.addEventListener('open', onOpen, { once: true });
  socket.addEventListener('error', onError, { once: true });
});
const evaluate = async (expression) => {
  const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Evaluation failed');
  return response.result.value;
};
const clickButton = async (text, startsWith = false) => {
  const found = await evaluate(`(() => { const value=${JSON.stringify(text)}; const button=[...document.querySelectorAll('button')].find((item)=>${startsWith ? 'item.textContent.trim().startsWith(value)' : 'item.textContent.trim()===value'}); if(!button)return false; button.click(); return true; })()`);
  if (!found) throw new Error(`Button not found: ${text}`);
};
const screenshot = async (name) => {
  const result = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(outputDirectory, name), Buffer.from(result.data, 'base64'));
};
try {
  await waitForSocketOpen();
  await command('Runtime.enable');
  await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await command('Fetch.enable', {
    patterns: [{
      urlPattern: '*qa-openai/v1/chat/completions*',
      requestStage: 'Request',
    }],
  });

  let rawState = '';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    rawState = await evaluate(`localStorage.getItem(${JSON.stringify(qaTextStorageKey)}) || ''`);
    if (rawState) break;
    await delay(100);
  }
  const configuredState = configureQaTextApiState(
    rawState,
    qaTextApiBaseUrl,
    qaMockApiKey,
  );
  await evaluate(`localStorage.setItem(${JSON.stringify(qaTextStorageKey)}, ${JSON.stringify(configuredState)})`);
  await command('Page.reload', { ignoreCache: true });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await evaluate(`Boolean(document.querySelector('.app-shell'))`)) break;
    await delay(100);
  }
  if (!(await evaluate(`Boolean(document.querySelector('.app-shell'))`))) {
    throw new Error('Application did not reload after configuring the QA text API');
  }

  const updateLogSidebar = await evaluate(`(() => {
    const updateButton = document.querySelector('.update-log-trigger');
    const errorButton = document.querySelector('.runtime-error-log-trigger');
    const utilityStack = updateButton?.closest('.sidebar-utility-stack');
    const errorSlot = errorButton?.closest('.runtime-error-log-slot');
    const sidebarNav = document.querySelector('.nav');
    const updateRect = updateButton?.getBoundingClientRect();
    const errorRect = errorButton?.getBoundingClientRect();
    return {
      updateText: updateButton?.textContent?.replace(/\\s+/gu, ' ').trim() || '',
      errorText: errorButton?.textContent?.replace(/\\s+/gu, ' ').trim() || '',
      updateHeight: updateRect?.height ?? null,
      errorHeight: errorRect?.height ?? null,
      updateBottom: updateRect?.bottom ?? null,
      errorTop: errorRect?.top ?? null,
      updateAboveError: Boolean(updateRect && errorRect && updateRect.bottom <= errorRect.top + 0.5),
      immediatelyBeforeError: Boolean(
        utilityStack
        && errorSlot
        && updateButton?.parentElement === utilityStack
        && errorSlot.parentElement === utilityStack
        && updateButton.nextElementSibling === errorSlot
      ),
      navScrollable: Boolean(sidebarNav && sidebarNav.scrollHeight > sidebarNav.clientHeight + 1),
    };
  })()`);
  if (
    !updateLogSidebar.updateText.startsWith('更新日志')
    || !updateLogSidebar.errorText.startsWith('报错日志')
    || !updateLogSidebar.updateAboveError
    || !updateLogSidebar.immediatelyBeforeError
    || updateLogSidebar.navScrollable
    || Math.abs((updateLogSidebar.updateHeight ?? 0) - 18) > 0.5
    || Math.abs((updateLogSidebar.errorHeight ?? 0) - 18) > 0.5
  ) {
    throw new Error(`Sidebar log controls must be half-height and ordered correctly: ${JSON.stringify(updateLogSidebar)}`);
  }
  await clickButton('更新日志', true);
  await delay(100);
  const updateLog = await evaluate(`(() => {
    const dialog = document.querySelector('.update-log-modal[role="dialog"]');
    const list = dialog?.querySelector('.update-log-list');
    const versions = [...(dialog?.querySelectorAll('[data-update-log-version]') || [])]
      .map((item) => item.getAttribute('data-update-log-version'));
    const highlightCounts = [...(dialog?.querySelectorAll('[data-update-log-version]') || [])]
      .map((item) => item.querySelectorAll('li').length);
    const listRect = list?.getBoundingClientRect();
    const dialogRect = dialog?.getBoundingClientRect();
    if (list) list.scrollTop = list.scrollHeight;
    return {
      heading: dialog?.querySelector('h3')?.textContent?.trim() || '',
      versions,
      highlightCounts,
      currentLabel: dialog?.querySelector('.update-log-current')?.textContent?.trim() || '',
      currentVersion: dialog
        ?.querySelector('.update-log-entry.current')
        ?.getAttribute('data-update-log-version') || '',
      scrollable: Boolean(list && list.scrollHeight > list.clientHeight + 1),
      scrolledToBottom: Boolean(list
        && list.scrollTop > 0
        && Math.abs(list.scrollHeight - list.clientHeight - list.scrollTop) <= 1),
      insideViewport: Boolean(dialogRect
        && dialogRect.left >= -0.5
        && dialogRect.top >= -0.5
        && dialogRect.right <= innerWidth + 0.5
        && dialogRect.bottom <= innerHeight + 0.5),
      listInsideDialog: Boolean(listRect && dialogRect
        && listRect.left >= dialogRect.left - 0.5
        && listRect.top >= dialogRect.top - 0.5
        && listRect.right <= dialogRect.right + 0.5
        && listRect.bottom <= dialogRect.bottom + 0.5),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  })()`);
  if (
    updateLog.heading !== '更新日志'
    || JSON.stringify(updateLog.versions) !== JSON.stringify(expectedUpdateLogVersions)
    || updateLog.highlightCounts.some((count) => count < 2)
    || updateLog.currentLabel !== '当前版本'
    || updateLog.currentVersion !== expectedUpdateLogCurrentVersion
    || !updateLog.scrollable
    || !updateLog.scrolledToBottom
    || !updateLog.insideViewport
    || !updateLog.listInsideDialog
    || updateLog.overflowX
  ) {
    throw new Error(`Update log dialog must show recent versions in a bounded scroll area: ${JSON.stringify(updateLog)}`);
  }
  await screenshot('00-update-log.png');
  await clickButton('关闭');
  await delay(50);
  if (await evaluate(`Boolean(document.querySelector('.update-log-modal'))`)) {
    throw new Error('Update log dialog did not close');
  }

  await clickButton('视频导演台');
  await delay(250);
  const autoShotPlanning = await evaluate(`(() => ({
    summary: document.querySelector('.director-setup-head .badge')?.textContent?.trim() || '',
    countValue: document.querySelector('.timing-parameter-card.count-card input')?.value || '',
    recommendation: document.querySelector('.recommendation-strip')?.innerText || '',
    generateButton: [...document.querySelectorAll('button')]
      .map((item) => item.textContent.trim())
      .find((text) => text.includes('分镜') && text.includes('生成提示词')) || '',
  }))()`);
  if (
    autoShotPlanning.summary !== '15 秒 · AI 待定'
    || autoShotPlanning.countValue !== ''
    || !autoShotPlanning.recommendation.includes('AI 生成时独立决定镜头数量')
    || /AI 推荐\s*\d+\s*镜/u.test(autoShotPlanning.recommendation)
    || autoShotPlanning.generateButton !== 'AI 分镜并生成提示词'
  ) {
    throw new Error(`Automatic shot planning must not present a local count as an AI result: ${JSON.stringify(autoShotPlanning)}`);
  }
  const automaticGenerationRequestStart = qaTextRequests.length;
  await clickButton('AI 分镜并生成提示词');
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await evaluate(`document.querySelector('.topbar h1')?.textContent?.trim()==='分镜时间线'`)) break;
    await delay(200);
  }
  if (!(await evaluate(`document.querySelector('.topbar h1')?.textContent?.trim()==='分镜时间线'`))) throw new Error('Storyboard generation did not finish');
  await clickButton('视频导演台');
  await delay(150);
  const bilingualResult = await evaluate(`(() => {
    const raw = localStorage.getItem(${JSON.stringify(qaTextStorageKey)});
    const state = raw ? JSON.parse(raw) : null;
    const board = [...(state?.project?.storyboards || [])]
      .sort((left, right) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0))
      .at(-1);
    const languageButtons = [...document.querySelectorAll('.result-language-switch button')];
    const copy = document.querySelector('.director-result-copy')?.textContent?.trim() || '';
    const copyButton = [...document.querySelectorAll('.result-language-tools button')]
      .find((button) => button.textContent?.trim() === '复制');
    const header = document.querySelector('.director-result-head');
    const bounds = (element) => element?.getBoundingClientRect() || null;
    const overlaps = (left, right) => Boolean(
      left && right
      && left.left < right.right - 0.5
      && left.right > right.left + 0.5
      && left.top < right.bottom - 0.5
      && left.bottom > right.top + 0.5
    );
    const languageRects = languageButtons.map(bounds);
    const copyRect = bounds(copyButton);
    const headerRect = bounds(header);
    const oldTranslationButtons = [...document.querySelectorAll('button')]
      .map((button) => button.textContent?.trim() || '')
      .filter((text) => text === '转成英文' || text === '重新翻译英文');
    return {
       board: board ? {
         finalPrompt: board.finalPrompt || '',
         officialPromptZh: board.officialPromptZh || '',
         officialPromptEn: board.officialPromptEn || '',
         officialPromptEnSource: board.officialPromptEnSource || '',
         englishPrompt: board.englishPrompt || '',
         englishPromptSource: board.englishPromptSource || '',
       } : null,
      languageLabels: languageButtons.map((button) => button.textContent?.trim() || ''),
      activeLanguage: languageButtons.find((button) => button.classList.contains('active'))
        ?.textContent?.trim() || '',
      displayedPrompt: copy,
      oldTranslationButtons,
      cardsOverlap: languageRects.some((rect, index) => (
        index > 0 && overlaps(languageRects[index - 1], rect)
      )),
      copyOverlapsCard: languageRects.some((rect) => overlaps(rect, copyRect)),
      controlsInsideHeader: Boolean(headerRect && copyRect && languageRects.every((rect) => (
        rect
        && rect.left >= headerRect.left - 1
        && rect.right <= headerRect.right + 1
        && rect.top >= headerRect.top - 1
        && rect.bottom <= headerRect.bottom + 1
      )) && copyRect.left >= headerRect.left - 1 && copyRect.right <= headerRect.right + 1),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  })()`);
  if (
     !bilingualResult.board?.finalPrompt
     || !bilingualResult.board.officialPromptZh
     || !bilingualResult.board.officialPromptEn
     || bilingualResult.board.englishPromptSource !== bilingualResult.board.finalPrompt
    || JSON.stringify(bilingualResult.languageLabels) !== JSON.stringify(['中文', 'English'])
    || bilingualResult.activeLanguage !== '中文'
     || bilingualResult.displayedPrompt !== bilingualResult.board.officialPromptZh.trim()
    || bilingualResult.oldTranslationButtons.length
    || bilingualResult.cardsOverlap
    || bilingualResult.copyOverlapsCard
    || !bilingualResult.controlsInsideHeader
    || bilingualResult.overflowX
  ) {
    throw new Error(`Generated storyboard must persist and render both prompt languages without a manual translation action: ${JSON.stringify(bilingualResult)}`);
  }
  await clickButton('English');
  await delay(50);
  const englishResult = await evaluate(`(() => ({
    activeLanguage: [...document.querySelectorAll('.result-language-switch button')]
      .find((button) => button.classList.contains('active'))?.textContent?.trim() || '',
    displayedPrompt: document.querySelector('.director-result-copy')?.textContent?.trim() || '',
  }))()`);
  if (
    englishResult.activeLanguage !== 'English'
     || englishResult.displayedPrompt !== bilingualResult.board.officialPromptEn.trim()
  ) {
    throw new Error(`English result card did not reveal the persisted English prompt: ${JSON.stringify({ bilingualResult, englishResult })}`);
  }
  await screenshot('01-bilingual-prompt-result.png');
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1120,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(`document.querySelector('.app-shell')?.style.setProperty('--ui-font-scale', '1.3')`);
  await delay(80);
  const compactBilingualLayout = await evaluate(`(() => {
    const header = document.querySelector('.director-result-head');
    const panel = document.querySelector('.director-result-pane');
    const cards = [...document.querySelectorAll('.result-language-card')];
    const copy = [...document.querySelectorAll('.result-language-tools button')]
      .find((button) => button.textContent?.trim() === '复制');
    const rect = (element) => element?.getBoundingClientRect() || null;
    const overlaps = (left, right) => Boolean(
      left && right
      && left.left < right.right - 0.5
      && left.right > right.left + 0.5
      && left.top < right.bottom - 0.5
      && left.bottom > right.top + 0.5
    );
    const headerRect = rect(header);
    const panelRect = rect(panel);
    const cardRects = cards.map(rect);
    const copyRect = rect(copy);
    const controls = [...cardRects, copyRect].filter(Boolean);
    return {
      fontScale: getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--ui-font-scale').trim(),
      cardCount: cards.length,
      cardsOverlap: overlaps(cardRects[0], cardRects[1]),
      copyOverlapsCard: cardRects.some((cardRect) => overlaps(cardRect, copyRect)),
      controlsInsideHeader: Boolean(headerRect && controls.every((control) => (
        control.left >= headerRect.left - 1
        && control.right <= headerRect.right + 1
        && control.top >= headerRect.top - 1
        && control.bottom <= headerRect.bottom + 1
      ))),
      headerInsidePanel: Boolean(headerRect && panelRect
        && headerRect.left >= panelRect.left - 1
        && headerRect.right <= panelRect.right + 1
        && headerRect.top >= panelRect.top - 1
        && headerRect.bottom <= panelRect.bottom + 1),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  })()`);
  await screenshot('01-bilingual-prompt-result-1120x720-font-130.png');
  if (
    compactBilingualLayout.fontScale !== '1.3'
    || compactBilingualLayout.cardCount !== 2
    || compactBilingualLayout.cardsOverlap
    || compactBilingualLayout.copyOverlapsCard
    || !compactBilingualLayout.controlsInsideHeader
    || !compactBilingualLayout.headerInsidePanel
    || compactBilingualLayout.overflowX
  ) {
    throw new Error(`Bilingual result controls overlap at 1120x720 and 130% font scale: ${JSON.stringify(compactBilingualLayout)}`);
  }
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(`document.querySelector('.app-shell')?.style.setProperty('--ui-font-scale', '1')`);
  await delay(50);
  await clickButton('中文');
  await delay(50);
  const restoredChinesePrompt = await evaluate(
    `document.querySelector('.director-result-copy')?.textContent?.trim() || ''`,
  );
  if (restoredChinesePrompt !== bilingualResult.board.officialPromptZh.trim()) {
    throw new Error('Chinese result card did not restore the persisted Chinese prompt');
  }
  await clickButton('分镜时间线');
  await delay(150);
  await clickButton('展开工具');
  await delay(100);
  await clickButton('保存当前版本');
  await delay(100);
  const selected = await evaluate(`(() => { const label=[...document.querySelectorAll('label')].find((item)=>item.textContent.includes('全选')); const input=label?.querySelector('input[type=checkbox]'); if(!input)return false; input.click(); return true; })()`);
  if (!selected) throw new Error('Select-all checkbox not found');
  await clickButton('批量锁定');
  await delay(150);
  await clickButton('保存 A/B 基线');
  await delay(150);
  const storyboard = await evaluate(`(() => ({
    shotCards: document.querySelectorAll('.shot-card').length,
    selectedCards: document.querySelectorAll('.shot-card.selected').length,
    lockedCards: document.querySelectorAll('.shot-card.locked').length,
    revisionText: document.querySelector('.revision-panel')?.innerText || '',
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    validation: [...document.querySelectorAll('.prompt-validation strong')].map((item)=>item.textContent),
    aiShotBadge: (document.body.innerText.match(/AI\\s*分镜\\s*\\d+\\s*镜/u)?.[0] || '')
      .replace(/\\s+/gu, ' '),
    hasModelEvidence: document.body.innerText.includes('AI 规划第 1 镜')
      && document.body.innerText.includes('AI 规划第 2 镜'),
  }))()`);
  await screenshot('01-storyboard-workflow.png');
  if (!storyboard.shotCards || storyboard.lockedCards !== storyboard.shotCards || !storyboard.revisionText.includes('A/B')) throw new Error(`Storyboard workflow incomplete: ${JSON.stringify(storyboard)}`);
  if (
    storyboard.shotCards !== 2
    || storyboard.aiShotBadge !== 'AI 分镜 2 镜'
    || !storyboard.hasModelEvidence
  ) {
    throw new Error(`Storyboard must label only the model-returned shot count as AI: ${JSON.stringify(storyboard)}`);
  }
  const automaticGenerationRequests = qaTextRequests.slice(automaticGenerationRequestStart);
  if (JSON.stringify(automaticGenerationRequests) !== JSON.stringify([
    'director',
    'shot-recommendation',
    'converter',
    'translator',
  ])) {
    throw new Error(`Automatic storyboard generation must finish with one English translation: ${JSON.stringify(automaticGenerationRequests)}`);
  }
  const missingTextRequests = ['director', 'shot-recommendation', 'converter', 'translator']
    .filter((callKind) => !qaTextRequests.includes(callKind));
  if (missingTextRequests.length || qaTextMockErrors.length) {
    throw new Error(`Workflow text API fixture incomplete: ${JSON.stringify({ missingTextRequests, qaTextRequests, qaTextMockErrors })}`);
  }

  await clickButton('视频导演台');
  await delay(150);
  await clickButton('精确指定');
  const exactCountChanged = await evaluate(`(() => {
    const input = document.querySelector('.timing-parameter-card.count-card input');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(input, '3');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  if (!exactCountChanged) throw new Error('Exact AI shot-count input was not available');
  await delay(100);
  const exactPlanningStart = qaStoryboardPlanningPayloads.length;
  const exactGenerationRequestStart = qaTextRequests.length;
  await clickButton('AI 按 3 镜分镜并生成提示词');
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await evaluate(`document.querySelector('.topbar h1')?.textContent?.trim()==='分镜时间线'`)) break;
    await delay(200);
  }
  if (!(await evaluate(`document.querySelector('.topbar h1')?.textContent?.trim()==='分镜时间线'`))) {
    throw new Error('Exact-count AI storyboard generation did not finish');
  }
  const exactStoryboard = await evaluate(`(() => ({
    shotCards: document.querySelectorAll('.shot-card').length,
    aiShotBadge: (document.body.innerText.match(/AI\\s*按指定\\s*3\\s*镜/u)?.[0] || '')
      .replace(/\\s+/gu, ' '),
    hasModelEvidence: document.body.innerText.includes('AI 规划第 3 镜'),
  }))()`);
  const exactPlanning = qaStoryboardPlanningPayloads[exactPlanningStart];
  if (
    exactPlanning?.requiredShotCount !== 3
    || exactStoryboard.shotCards !== 3
    || exactStoryboard.aiShotBadge !== 'AI 按指定 3 镜'
    || !exactStoryboard.hasModelEvidence
  ) {
    throw new Error(`Exact mode must lock only the count while AI owns all shot content: ${JSON.stringify({ exactPlanning, exactStoryboard })}`);
  }
  const exactGenerationRequests = qaTextRequests.slice(exactGenerationRequestStart);
  if (JSON.stringify(exactGenerationRequests) !== JSON.stringify([
    'director',
    'shot-recommendation',
    'converter',
    'translator',
  ])) {
    throw new Error(`Exact-count generation must finish with one English translation: ${JSON.stringify(exactGenerationRequests)}`);
  }

  await clickButton('视频导演台');
  await delay(150);
  await clickButton('AI 自动');
  await delay(100);
  const authRequestStart = qaTextRequests.length;
  qaTextFailureMode = 'auth';
  await clickButton('AI 分镜并生成提示词');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const notice = await evaluate(`document.querySelector('.sidebar-notice')?.textContent?.trim() || ''`);
    if (notice.includes('认证失败')) break;
    await delay(100);
  }
  qaTextFailureMode = '';
  const authFailure = await evaluate(`(() => ({
    notice: document.querySelector('.sidebar-notice')?.textContent?.trim() || '',
    generateButton: [...document.querySelectorAll('button')]
      .map((item) => item.textContent.trim())
      .find((text) => text === 'AI 分镜并生成提示词') || '',
  }))()`);
  const authRequests = qaTextRequests.slice(authRequestStart);
  if (
    authFailure.notice !== '文本模型认证失败：接口拒绝当前密钥或账户授权，请在 API 设置中更新后先测试连接。'
    || authFailure.generateButton !== 'AI 分镜并生成提示词'
    || authRequests.length !== 1
    || authRequests[0] !== 'director'
  ) {
    throw new Error(`Authentication failure must stop before a duplicate AI planning request: ${JSON.stringify({ authFailure, authRequests })}`);
  }

  await clickButton('生成任务');
  await delay(150);
  const jobs = await evaluate(`(() => ({
    request: document.querySelector('.job-request')?.value || '',
    heading: document.querySelector('.topbar h1')?.textContent?.trim() || '',
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  }))()`);
  await screenshot('02-generation-request.png');
  if (jobs.heading !== '生成任务' || !jobs.request.includes('prompt') || jobs.overflowX) throw new Error(`Generation request incomplete: ${JSON.stringify(jobs)}`);

  const errorLogCounter = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((item) => item.textContent.trim().startsWith('报错日志'));
    return button?.textContent?.replace(/\\s+/gu, ' ').trim() || '';
  })()`);
  if (!/^报错日志(?:\s|[（(])*1(?:[）)])?$/u.test(errorLogCounter)) {
    throw new Error(`Sidebar error log must show one recorded failure: ${JSON.stringify({ errorLogCounter })}`);
  }
  const clipboardStubInstalled = await evaluate(`(() => {
    globalThis.__qaCopiedErrorLog = '';
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value) => {
            globalThis.__qaCopiedErrorLog = String(value);
          },
        },
      });
      return true;
    } catch {
      return false;
    }
  })()`);
  if (!clipboardStubInstalled) throw new Error('QA could not install the clipboard boundary stub');
  await clickButton('报错日志', true);
  await delay(100);
  const errorLogDetail = await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((item) => item.textContent.includes('报错日志'));
    return dialog?.innerText || '';
  })()`);
  if (
    !errorLogDetail.includes('智能导演判断')
    || !errorLogDetail.includes('Authentication Fails (governor)')
    || errorLogDetail.includes(qaMockApiKey)
  ) {
    throw new Error(`Error log dialog must retain the failing stage and complete upstream error: ${JSON.stringify({ errorLogDetail })}`);
  }
  await clickButton('复制日志');
  await delay(50);
  const copiedErrorLog = await evaluate(`String(globalThis.__qaCopiedErrorLog || '')`);
  if (
    !copiedErrorLog.includes('智能导演判断')
    || !copiedErrorLog.includes('Authentication Fails (governor)')
    || copiedErrorLog.includes(qaMockApiKey)
  ) {
    throw new Error(`Copied error log must be complete and redact API credentials: ${JSON.stringify({ copiedErrorLog })}`);
  }
  await clickButton('清空日志');
  await delay(50);
  const clearedErrorLog = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((item) => item.textContent.trim().startsWith('报错日志'));
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((item) => item.textContent.includes('报错日志'));
    return {
      counter: button?.textContent?.replace(/\\s+/gu, ' ').trim() || '',
      detail: dialog?.innerText || '',
    };
  })()`);
  if (
    !/^报错日志(?:\s|[（(])*0(?:[）)])?$/u.test(clearedErrorLog.counter)
    || clearedErrorLog.detail.includes('Authentication Fails (governor)')
  ) {
    throw new Error(`Clearing the error log must reset its count and remove entries: ${JSON.stringify({ clearedErrorLog })}`);
  }

  const report = {
    updateLogSidebar,
    updateLog,
    storyboard,
    exactStoryboard,
    automaticGenerationRequests,
    exactGenerationRequests,
    bilingualResult,
    englishResult,
    compactBilingualLayout,
    authFailure,
    authRequests,
    jobs,
    errorLogCounter,
    errorLogDetail,
    copiedErrorLog,
    clearedErrorLog,
    qaTextRequests,
    qaTextMockErrors,
    consoleErrors,
  };
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  if (consoleErrors.length) throw new Error(consoleErrors.join(' | '));
  console.log(JSON.stringify(report, null, 2));
} finally {
  failPending('workflow smoke finished');
  socket.close();
}
