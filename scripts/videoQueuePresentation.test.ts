import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { videoQueueBlockerSummary } from '../src/videoQueuePresentation';
import type { Project, VideoGenerationTask } from '../src/types';

const initial = createInitialState();
const task = (id: string, endpoint = 'https://cloud.invalid/run'): VideoGenerationTask => ({
  id, kind: 'video', status: 'running', remoteTaskId: `remote-${id}`, targetId: 'mock', storyboardId: '',
  requestBody: {}, createdAt: 1, updatedAt: 2,
  videoJob: { stage: 'running', preparation: { version: 1, phase: 'acknowledged', uploadedImages: [] },
    snapshot: { projectId: 'project', clientId: 'client', images: [],
      draft: { name: `Cloud render ${id}`, backend: 'api', prompt: 'PRIVATE-FULL-PROMPT', references: [], parameters: {} },
      connection: { backend: 'api', api: { ...initial.settings.videoTaskApi, enabled: true, provider: 'generic', endpoint } } } },
});
const project = (name: string, tasks: VideoGenerationTask[]): Pick<Project, 'id' | 'name' | 'generationTasks'> => ({ id: name, name, generationTasks: tasks });
const waiting = task('waiting');
waiting.status = 'draft'; waiting.remoteTaskId = undefined;
waiting.videoJob!.preparation!.phase = 'preparing'; waiting.videoJob!.stage = 'queued';
const stopped = task('stopped'); stopped.status = 'unknown'; stopped.videoJob!.trackingStopped = true; stopped.videoJob!.stage = 'stopped';
const other = task('other', 'https://another.invalid/run');
const ended = task('ended'); ended.videoJob!.remoteGenerationEnded = true;
const unknown = task('unknown'); unknown.videoJob!.legacyMetadataIncomplete = true;
const projects = [project('当前项目', [waiting]), project('此前项目甲', [stopped]), project('不同服务', [other]),
  project('已完成', [ended]), project('旧来源', [unknown])];
const before = JSON.stringify(projects);
const summary = videoQueueBlockerSummary(projects, waiting);
assert.doesNotMatch(summary, /此前项目甲|Cloud render stopped|停止跟踪/u);
assert.match(summary, /旧来源.*Cloud render unknown.*来源连接待核实/u);
assert.doesNotMatch(summary, /不同服务|Cloud render other|Cloud render ended|Cloud render waiting|PRIVATE-FULL-PROMPT/u);
assert.equal(JSON.stringify(projects), before);
assert.equal(videoQueueBlockerSummary([project('unrelated', [other, ended])], waiting), '');

const secret = 'PRIVATE-KEY-DO-NOT-RENDER';
const sensitive = task(`id-${secret}`);
sensitive.videoJob!.snapshot.draft.name = `Render ${secret} PRIVATE-FULL-PROMPT data:image/png;base64,SECRETPIXELS`;
const safe = videoQueueBlockerSummary([project(`Project ${secret} https://u:p@cloud.invalid/path?token=SECRETQUERY`, [sensitive])], waiting, [secret]);
assert.doesNotMatch(safe, /PRIVATE-KEY|DO-NOT-RENDER|PRIVATE-FULL-PROMPT|SECRETPIXELS|SECRETQUERY|u:p@/u);
assert.match(safe, /已脱敏/u);

const many = Array.from({ length: 11 }, (_, index) => task(`job-${index}`));
const bounded = videoQueueBlockerSummary([project('大型旧批次', many)], waiting);
assert.equal(bounded.split('\n').filter((line) => /^\d+\./u.test(line)).length, 8);
assert.match(bounded, /另有 3 条占位任务/u);
assert.equal(videoQueueBlockerSummary([project('已停止列表', [stopped, stopped])], waiting, [], new Set([stopped.id])), '');
assert.equal(videoQueueBlockerSummary([project('重复列表', [unknown, unknown])], waiting).split('\n').filter((line) => /^\d+\./u.test(line)).length, 1);
const preparing = structuredClone(waiting); preparing.id = 'preparing-other'; preparing.videoJob!.snapshot.draft.name = '正在上传素材的任务';
assert.equal(videoQueueBlockerSummary([project('素材项目', [preparing])], waiting), '');
assert.match(videoQueueBlockerSummary([project('素材项目', [preparing])], waiting, [], new Set([preparing.id])), /正在上传素材的任务.*准备素材中（尚未提交）/u);
console.log('Video queue presentation: scope, unknown reservations, concrete blockers, bounded redaction and read-only behavior passed.');
