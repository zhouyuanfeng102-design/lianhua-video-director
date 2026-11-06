import assert from 'node:assert/strict';
import { buildRhWebBody, createRunningHubWebApp, defaultRunningHubWebConfig, knownMiniMaxH3WebFields, mergeRunningHubWebRead, normalizeRunningHubWebConfig, parseRunningHubWebAddress, removeRunningHubWebAccount } from '../src/runningHubWeb';
import type { VideoGenerationDraft } from '../src/videoGenerationTypes';
import { compileRunningHubWebApi } from '../src/runningHubWeb';

const parsed = parseRunningHubWebAddress('https://www.runninghub.ai/zh-cn/ai-detail/2104753059472990209');
assert.equal(parsed.remoteId, '2104753059472990209');
assert.equal(parsed.site, 'ai');
assert.throws(() => parseRunningHubWebAddress('https://example.com/ai-detail/2104753059472990209'), /runninghub/u);

const config = defaultRunningHubWebConfig();
config.enabled = true;
const app = createRunningHubWebApp(parsed.url, config.accounts[0].id);
assert.equal(app.fields.filter((field) => field.bind === 'image').length, 6);
assert.equal(app.fields.find((field) => field.key === 'text:prompt')?.bind, 'idea');
assert.equal(app.fields.find((field) => field.key === 'number:duration')?.bind, 'duration');
config.apps = [app];
config.activeAppId = app.id;

const changed = mergeRunningHubWebRead(app, {
  fields: knownMiniMaxH3WebFields().map((field) => ({ ...field, value: field.key === 'number:duration' ? 12 : field.value })),
  instance: 'Plus',
  estimate: '≈ 100 RH币',
});
assert.equal(changed.ready, true);
assert.equal(mergeRunningHubWebRead({ ...app, name: `网页应用 ${app.remoteId}` }, { fields: app.fields, name: '页面上的应用名' }).name, '页面上的应用名');
assert.equal(changed.fields.find((field) => field.key === 'text:prompt')?.bind, 'idea');
assert.equal(changed.estimate, '≈ 100 RH币');

const api = compileRunningHubWebApi(config, app.id);
const draft: VideoGenerationDraft = {
  name: '网页试生成', prompt: '完整提示词留在软件里', backend: 'api', runningHubWebAppId: app.id,
  references: [], audioReferences: [], parameters: { idea: '她转身看向镜头', duration: 12, aspect_ratio: '9:16' },
};
const body = buildRhWebBody(api, draft, []);
const fields = body.fields as Array<{ key: string; value: unknown }>;
assert.equal(fields.find((field) => field.key === 'text:prompt')?.value, '她转身看向镜头');
assert.equal(body.prompt, draft.prompt);
assert.equal(fields.find((field) => field.key === 'number:duration')?.value, 12);
const keptDuration = buildRhWebBody({ ...api, rhWebFields: (api.rhWebFields || []).map((field) => field.key === 'number:duration' ? { ...field, value: '30' } : field) }, { ...draft, parameters: { idea: '她转身看向镜头' } }, []);
assert.equal((keptDuration.fields as Array<{ key: string; value: unknown }>).find((field) => field.key === 'number:duration')?.value, 30);
assert.equal(fields.find((field) => field.key === 'select:aspect')?.value, '9:16 (Portrait Widescreen)');
const withoutIdea = buildRhWebBody(api, { ...draft, parameters: {} }, []);
assert.equal((withoutIdea.fields as Array<{ key: string; value: unknown }>).find((field) => field.key === 'text:prompt')?.value, draft.prompt);
assert.throws(() => buildRhWebBody(api, { ...draft, prompt: '拍摄时尚杂志，性感姿势', parameters: { idea: '拍摄时尚杂志，性感姿势' } }, []), /提示词是空的/u);

const stored = normalizeRunningHubWebConfig({ ...config, apps: [{ ...app, ready: true }] });
assert.equal(stored.apps[0]?.fields.length, app.fields.length);
assert.equal(normalizeRunningHubWebConfig({ apps: [{ remoteId: '1', name: '坏', accountId: config.accounts[0].id }] }).apps.length, 0);

const withTwo = {
  ...stored,
  accounts: [...stored.accounts, { id: 'rh-web-extra', name: '小号', site: 'cn' as const }],
  activeAccountId: 'rh-web-extra',
};
const removedExtra = removeRunningHubWebAccount(withTwo, 'rh-web-extra');
assert.equal(removedExtra.accounts.some((item) => item.id === 'rh-web-extra'), false);
assert.equal(removedExtra.apps.length, stored.apps.length);
assert.equal(removedExtra.activeAccountId, stored.accounts[0].id);

const removedLast = removeRunningHubWebAccount(stored, stored.accounts[0].id);
assert.equal(removedLast.accounts.length, 0);
assert.equal(removedLast.apps.length, 1);
const kept = normalizeRunningHubWebConfig(removedLast);
assert.equal(kept.accounts.length, 0);
assert.equal(kept.apps.length, 1);
assert.equal(kept.apps[0]?.id, stored.apps[0]?.id);
console.log('runningHubWeb bindings ok');
