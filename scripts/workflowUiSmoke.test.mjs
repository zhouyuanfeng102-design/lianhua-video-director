import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.resolve('scripts/workflowUiSmoke.mjs'), 'utf8');
const appSource = fs.readFileSync(path.resolve('src/App.tsx'), 'utf8');

const loadErrorLogCounterMatchers = () => source
  .split(/\r?\n/u)
  .filter((line) => line.includes('^报错日志'))
  .map((line) => {
    const literalStart = line.indexOf('/');
    const literalEnd = line.indexOf('/u.test(', literalStart);
    assert.ok(
      literalStart >= 0 && literalEnd > literalStart,
      'workflow smoke error-log checks must expose executable regular expressions',
    );
    return vm.runInNewContext(line.slice(literalStart, literalEnd + 2));
  });

test('workflow smoke error-log counters accept normalized whitespace, not a literal backslash-s', () => {
  const matchers = loadErrorLogCounterMatchers();
  assert.equal(
    matchers.length,
    2,
    'both the recorded and cleared error-log counters must be checked',
  );
  const [recordedCounter, clearedCounter] = matchers;
  assert.equal(recordedCounter.test('报错日志 1'), true);
  assert.equal(recordedCounter.test('报错日志（1）'), true);
  assert.equal(recordedCounter.test(String.raw`报错日志\s1`), false);
  assert.equal(clearedCounter.test('报错日志 0'), true);
  assert.equal(clearedCounter.test('报错日志（0）'), true);
  assert.equal(clearedCounter.test(String.raw`报错日志\s0`), false);
});

test('workflow smoke derives the complete ordered update log from authoritative release metadata', () => {
  assert.match(source, /import \{ updateLogEntries \} from '\.\.\/src\/updateLog\.ts';/u);
  assert.match(source, /const expectedUpdateLogVersions = updateLogEntries\.map\(\(\{ version \}\) => version\);/u);
  assert.match(source, /const expectedUpdateLogCurrentVersion = String\(packageInfo\.version \|\| ''\)\.trim\(\);/u);
  assert.match(source, /expectedUpdateLogVersions\[0\] !== expectedUpdateLogCurrentVersion/u);
  assert.match(source, /JSON\.stringify\(updateLog\.versions\) !== JSON\.stringify\(expectedUpdateLogVersions\)/u);
  assert.match(source, /updateLog\.currentVersion !== expectedUpdateLogCurrentVersion/u);
  assert.doesNotMatch(source, /const expectedUpdateLogVersions = \[/u);
  assert.doesNotMatch(source, /updateLog\.currentVersion !== ['"]\d+\.\d+\.\d+['"]/u);
});

const loadQaTextApiHarness = () => {
  const start = source.indexOf('const qaTextStorageKey');
  const end = source.indexOf('const port', start);
  assert.ok(
    start >= 0 && end > start,
    'workflow smoke must expose executable text API setup and request fixtures',
  );
  const context = vm.createContext({
    Error,
    JSON,
    Map,
    RegExp,
    String,
  });
  vm.runInContext(
    `${source.slice(start, end)}\n;globalThis.__qaText = { configureQaTextApiState, qaTextRequestKind, qaTextResponseContent };`,
    context,
    { filename: 'workflowUiSmoke.mjs' },
  );
  return context.__qaText;
};

const loadCommandHarness = (timeoutMs = 5) => {
  const start = source.indexOf('const commandTimeoutMs');
  const end = source.indexOf('const evaluate', start);
  assert.ok(start >= 0 && end > start, 'workflow smoke must expose a bounded CDP command section');
  const listeners = new Map();
  const socket = {
    readyState: 1,
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) || []), listener]);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener({ type, ...event });
    },
    send() {},
  };
  const context = vm.createContext({
    clearTimeout,
    console,
    Error,
    JSON,
    Map,
    process: { env: { CDP_COMMAND_TIMEOUT_MS: String(timeoutMs) } },
    setTimeout,
    socket,
    String,
    WebSocket: { OPEN: 1 },
  });
  vm.runInContext(`${source.slice(start, end)}\n;globalThis.__qa = { command, pending };`, context, { filename: 'workflowUiSmoke.mjs' });
  return { socket, ...context.__qa };
};

test('workflow CDP commands time out and leave no pending entry', async () => {
  const harness = loadCommandHarness();
  await assert.rejects(harness.command('Runtime.evaluate'), /timed out|超时/i);
  assert.equal(harness.pending.size, 0);
});

test('workflow CDP disconnect rejects every pending command', async () => {
  const harness = loadCommandHarness(1000);
  const first = harness.command('Runtime.evaluate');
  const second = harness.command('Page.captureScreenshot');
  harness.socket.dispatch('close', { reason: 'lost' });
  await Promise.all([assert.rejects(first, /CDP|socket/i), assert.rejects(second, /CDP|socket/i)]);
  assert.equal(harness.pending.size, 0);
});

test('workflow smoke always closes its CDP socket', () => {
  assert.match(source, /try\s*\{[\s\S]*finally\s*\{\s*failPending\([^)]*\);\s*socket\.close\(\);\s*\}/u);
});

test('workflow smoke configures the persisted text API used by the UI', () => {
  const { configureQaTextApiState } = loadQaTextApiHarness();
  const original = {
    settings: {
      textApi: {
        enabled: false,
        provider: 'claude',
        baseUrl: '',
        apiKey: 'leave-empty-in-QA',
        model: '',
      },
    },
    project: { id: 'project-qa' },
  };
  const configured = JSON.parse(configureQaTextApiState(
    JSON.stringify(original),
    'http://127.0.0.1:5197/qa-openai/v1',
  ));

  assert.deepEqual(configured.project, original.project);
  assert.equal(configured.settings.textApi.enabled, true);
  assert.equal(configured.settings.textApi.provider, 'openai_compatible');
  assert.equal(configured.settings.textApi.baseUrl, 'http://127.0.0.1:5197/qa-openai/v1');
  assert.equal(configured.settings.textApi.apiKey, '');
  assert.equal(configured.settings.textApi.model, 'qa-model');
});

test('workflow smoke recognizes and answers the director, AI storyboard, converter, and translator requests', () => {
  const { qaTextRequestKind, qaTextResponseContent } = loadQaTextApiHarness();
  const payload = (system, user = '') => ({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  const directorPayload = payload('你是智能导演分类器');
  assert.equal(qaTextRequestKind(directorPayload), 'director');
  assert.match(qaTextResponseContent('director', directorPayload), /"mode"\s*:\s*"narrative"/u);

  const storyboardPayload = payload(
    '你是视频分镜规划器',
    `<storyboard_planning_data>${JSON.stringify({
      sourceStory: '李云进门。李云接信。李云望向门缝。李云吹灭烛火。',
      durationSec: 15,
    })}</storyboard_planning_data>`,
  );
  assert.equal(qaTextRequestKind(storyboardPayload), 'shot-recommendation');
  const storyboard = JSON.parse(qaTextResponseContent('shot-recommendation', storyboardPayload));
  assert.ok(storyboard.shots.length > 0);
  assert.equal(storyboard.shots[0].startSec, 0);
  assert.equal(storyboard.shots.at(-1).endSec, 15);

  const localStructureDraft = '【0s-4s】 主体：@李云（警觉）[朝向：门缝] 正在 [走进客栈]（建立人物）；空间：前景-雨水，中景-李云，背景-柜台；光影：烛火主光，3200K；镜头：中景固定；台词：无；音效：环境层-[雨声]，动作层-[脚步]，情绪层-[低频]';
  const converterPayload = payload(
    '<video_conversion_core_task>这是转化，不是润色。</video_conversion_core_task>',
    `<video_conversion_data>${JSON.stringify({
      shotEvidence: [{
        shot: 1,
        exactTimeLabel: '【0s-4s】',
        allowedSubjects: ['@李云'],
        expectedDialogues: [],
        localStructureDraft,
      }],
    })}</video_conversion_data>`,
  );
  assert.equal(qaTextRequestKind(converterPayload), 'converter');
  const converted = qaTextResponseContent('converter', converterPayload);
  assert.match(converted, /^【0s-4s】 主体：@李云/u);
  assert.notEqual(converted, localStructureDraft);
  assert.doesNotMatch(converted, /正在 \[走进客栈\]/u);

  const protectedTranslationSource = [
    '【0s-4s】主体：__LH_ENTITY_001__ 推门看向 __LH_ENTITY_002__；台词：无；音效：动作层-[脚步]',
    '【4s-8s】主体：__LH_ENTITY_002__ 回望 __LH_ENTITY_001__；台词：无；音效：环境层-[雨声]',
  ].join('\n');
  const translatorPayload = payload(
    '你是专业的视频生成提示词翻译器。只翻译语言。',
    protectedTranslationSource,
  );
  assert.equal(qaTextRequestKind(translatorPayload), 'translator');
  const translated = qaTextResponseContent('translator', translatorPayload);
  assert.deepEqual(
    translated.match(/【\s*\d+(?:\.\d+)?s\s*[-–—~～至]\s*\d+(?:\.\d+)?s\s*】/gu),
    protectedTranslationSource.match(/【\s*\d+(?:\.\d+)?s\s*[-–—~～至]\s*\d+(?:\.\d+)?s\s*】/gu),
  );
  assert.equal(translated.match(/__LH_ENTITY_001__/gu)?.length, 2);
  assert.equal(translated.match(/__LH_ENTITY_002__/gu)?.length, 2);
  assert.match(translated, /Subject:/u);
  assert.doesNotMatch(translated, /[\p{Script=Han}]/u);
});

test('director source removes the manual English-translation buttons', () => {
  assert.doesNotMatch(
    appSource,
    /转成英文|重新翻译英文/u,
    'English generation must be part of storyboard generation instead of a separate user action',
  );
});
