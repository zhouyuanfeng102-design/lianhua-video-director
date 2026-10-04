import { useEffect, useRef, useState } from 'react';
import type { AppState, Project, ReferenceAsset } from './types';
import { applyOwnedProjectUpdate } from './appEffects';
import { saveStateAsync } from './storage';
import { buildWorkbenchRenderRequest, createWorkbenchClip, emptyVideoWorkbenchDraft, frameWorkbenchAsset, renderedWorkbenchAsset,
  sequenceWorkbenchAssets, workbenchId, workbenchSource, workbenchVideoAsset,
  type VideoWorkbenchClip, type VideoWorkbenchDraft, type VideoWorkbenchFrameOptions, type VideoWorkbenchJob } from './videoWorkbench';
import type { VideoWorkbenchStatus, WorkbenchProgress, WorkbenchVideoProbe } from './videoWorkbenchTypes';

type Bridge = Pick<NonNullable<Window['lianhuaDesktop']>, 'videoWorkbenchStatus' | 'probeWorkbenchVideo' | 'extractWorkbenchFrames' | 'renderWorkbenchTimeline' | 'cancelWorkbenchJob' | 'onWorkbenchProgress' | 'importMedia'>;
type Update = (updater: (state: AppState) => AppState) => void;
interface EngineOptions {
  getState: () => AppState;
  setState: Update;
  desktop?: Bridge;
  onChange: () => void;
  persist?: () => Promise<void>;
  notify?: (message: string, tone?: 'normal' | 'error') => void;
}
export interface VideoWorkbenchController {
  draft: VideoWorkbenchDraft;
  jobs: VideoWorkbenchJob[];
  status?: VideoWorkbenchStatus;
  busy: boolean;
  error: string;
  progress?: WorkbenchProgress;
  probes: Record<string, WorkbenchVideoProbe>;
  refreshStatus: () => Promise<void>;
  updateDraft: (updater: (draft: VideoWorkbenchDraft) => VideoWorkbenchDraft) => void;
  probeAsset: (assetId: string) => Promise<WorkbenchVideoProbe>;
  importFiles: (files: File[]) => Promise<void>;
  addAssets: (assetIds: string[]) => Promise<void>;
  loadSequence: (planId: string) => Promise<void>;
  extractFrames: (assetId: string, options: VideoWorkbenchFrameOptions) => Promise<string[]>;
  extractBoundaries: (draft?: VideoWorkbenchDraft) => Promise<string[]>;
  renderTimeline: () => Promise<string | undefined>;
  cancel: () => Promise<void>;
  retryJob: (jobId: string) => Promise<void>;
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const aborted = (): Error => Object.assign(new Error('本地视频处理已取消；原素材保持不变。'), { name: 'AbortError' });

/** Lives at App root: navigation never owns encoding or result delivery. */
export class VideoWorkbenchEngine {
  status?: VideoWorkbenchStatus;
  error = '';
  progress?: WorkbenchProgress;
  private probes = new Map<string, WorkbenchVideoProbe>();
  private probing = new Map<string, Promise<WorkbenchVideoProbe>>();
  private setupBusy = false;
  private setupCancelled = false;
  private disposed = false;
  private unsubscribe?: () => void;
  private active?: { job: VideoWorkbenchJob; requestId: string; cancelled: boolean };
  constructor(private options: EngineOptions) {
    this.unsubscribe = options.desktop?.onWorkbenchProgress?.((progress) => {
      if (this.disposed || !this.active || this.active.cancelled || progress.jobId !== this.active.requestId || progress.projectId !== this.active.job.projectId) return;
      this.progress = progress; this.changed();
    });
  }
  get busy() { return this.setupBusy || Boolean(this.active); }
  private changed() { if (!this.disposed) this.options.onChange(); }
  private owner(projectId: string): Project | undefined {
    const state = this.options.getState();
    return state.project.id === projectId ? state.project : state.projects.find((project) => project.id === projectId);
  }
  private patch(projectId: string, update: (project: Project) => Project) { this.options.setState((state) => applyOwnedProjectUpdate(state, projectId, update)); }
  private bridge(): Bridge {
    if (!this.options.desktop?.probeWorkbenchVideo) throw new Error('视频工作台需要桌面版的本地媒体处理服务。');
    return this.options.desktop;
  }
  recoverInterrupted() {
    const state = this.options.getState();
    const ids = new Set([state.project.id, ...state.projects.map((project) => project.id)]);
    ids.forEach((id) => this.patch(id, (project) => {
      if (!project.videoWorkbench?.jobs.some((job) => job.status === 'running')) return project;
      return { ...project, videoWorkbench: { ...project.videoWorkbench, jobs: project.videoWorkbench.jobs.map((job) => job.status === 'running'
        ? { ...job, status: 'interrupted', error: '软件关闭时处理未完成；原素材保留，可手动重试。', updatedAt: Date.now() } : job) } };
    }));
  }
  async refreshStatus() {
    try { this.status = await this.bridge().videoWorkbenchStatus(); }
    catch (error) { this.status = { available: false, ffmpeg: false, ffprobe: false, message: messageOf(error) }; }
    this.changed();
  }
  draft(projectId: string) { return this.owner(projectId)?.videoWorkbench?.draft || emptyVideoWorkbenchDraft(projectId); }
  updateDraft(projectId: string, updater: (draft: VideoWorkbenchDraft) => VideoWorkbenchDraft) {
    this.patch(projectId, (project) => ({ ...project, videoWorkbench: { jobs: project.videoWorkbench?.jobs || [],
      draft: { ...updater(project.videoWorkbench?.draft || emptyVideoWorkbenchDraft(projectId)), updatedAt: Date.now() } } }));
  }
  probesFor(projectId: string): Record<string, WorkbenchVideoProbe> {
    return Object.fromEntries((this.owner(projectId)?.assets || []).flatMap((asset) => {
      const probe = this.probes.get(JSON.stringify([projectId, asset.id, asset.relativePath, asset.checksum]));
      return probe ? [[asset.id, probe]] : [];
    }));
  }
  async probeAsset(projectId: string, assetId: string): Promise<WorkbenchVideoProbe> {
    const sourceAsset = this.owner(projectId)?.assets.find((asset) => asset.id === assetId);
    const source = workbenchSource(sourceAsset);
    const key = JSON.stringify([projectId, assetId, sourceAsset!.relativePath, sourceAsset!.checksum]);
    const cached = this.probes.get(key); if (cached) return cached;
    const pending = this.probing.get(key); if (pending) return pending;
    const operation = this.bridge().probeWorkbenchVideo(source).then((probe) => {
      this.probes.set(key, probe);
      this.patch(projectId, (project) => ({ ...project, assets: project.assets.map((asset) => asset.id === assetId && asset.checksum === sourceAsset!.checksum && asset.relativePath === sourceAsset!.relativePath
        ? { ...asset, durationSec: probe.durationSec, width: probe.width, height: probe.height } : asset) }));
      this.changed(); return probe;
    }).finally(() => this.probing.delete(key));
    this.probing.set(key, operation); return operation;
  }
  private async setup<T>(work: (check: () => void) => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('已有本地视频处理任务，请等待完成或取消后再操作。');
    this.setupBusy = true; this.setupCancelled = false; this.progress = undefined; this.error = ''; this.changed();
    const check = () => { if (this.disposed || this.setupCancelled) throw aborted(); };
    try { return await work(check); } catch (error) { this.error = messageOf(error); throw error; }
    finally { this.setupBusy = false; this.changed(); }
  }
  async importFiles(projectId: string, files: File[]) {
    return this.setup(async (check) => {
      for (const file of files) {
        check();
        if (!this.owner(projectId)) throw new Error('导入所属项目已不存在。');
        const managed = await this.bridge().importMedia(file); if (!managed) continue;
        check();
        if (!['video', 'audio'].includes(managed.mediaType)) throw new Error('视频工作台只导入视频和音频。');
        const asset: ReferenceAsset = { ...managed, id: workbenchId('media'), name: file.name.replace(/\.[^.]+$/u, ''),
          type: managed.mediaType === 'video' ? 'video' : 'audio', role: managed.mediaType === 'video' ? 'motion' : 'audio',
          referenceRole: managed.mediaType === 'video' ? 'motion' : 'audio', source: 'upload', tags: ['工作台导入'], createdAt: Date.now(), updatedAt: Date.now() };
        this.patch(projectId, (project) => ({ ...project, assets: [...project.assets, asset] }));
        if (workbenchVideoAsset(asset)) await this.probeAsset(projectId, asset.id);
      }
    });
  }
  async addAssets(projectId: string, ids: string[]) {
    return this.setup(async (check) => {
      const owner = this.owner(projectId);
      if (!owner) throw new Error('选片所属项目已不存在，未追加视频。');
      const capturedDraftId = this.draft(projectId).id;
      // Capture file identity, not mutable asset object references. A slow
      // ffprobe reply belongs only to the exact selected file in its owner.
      const assets = ids.map((id) => {
        const asset = owner.assets.find((candidate) => candidate.id === id);
        if (!asset || !workbenchVideoAsset(asset)) throw new Error('请添加有效视频资产。');
        workbenchSource(asset);
        return structuredClone(asset);
      });
      const selectionIssue = (project: Project | undefined): string | undefined => {
        if (!project) return '选片所属项目已不存在，未追加视频。';
        if ((project.videoWorkbench?.draft || emptyVideoWorkbenchDraft(projectId)).id !== capturedDraftId) return '剪辑方案已切换，未追加过期选片。';
        for (const selected of assets) {
          const current = project.assets.find((asset) => asset.id === selected.id);
          if (!current || !workbenchVideoAsset(current) || current.missing) return `视频“${selected.name}”已删除或不可用，未追加过期选片。`;
          if (current.relativePath !== selected.relativePath || current.checksum !== selected.checksum) return `视频“${selected.name}”的文件已更换，请重新选择；未使用旧文件的解析结果。`;
        }
        return undefined;
      };
      const assertSelection = () => { const issue = selectionIssue(this.owner(projectId)); if (issue) throw new Error(issue); };
      const clips: VideoWorkbenchClip[] = [];
      for (const asset of assets) {
        check();
        assertSelection();
        const probe = await this.probeAsset(projectId, asset.id);
        check(); assertSelection();
        clips.push(createWorkbenchClip(asset, probe));
      }
      check(); assertSelection();
      let appendIssue: string | undefined;
      this.patch(projectId, (project) => {
        appendIssue = selectionIssue(project);
        if (appendIssue) return project;
        const draft = project.videoWorkbench?.draft || emptyVideoWorkbenchDraft(projectId);
        // Append to the live draft. Timeline edits made while probing must not
        // be overwritten by the older selection-time draft.
        return { ...project, videoWorkbench: { jobs: project.videoWorkbench?.jobs || [],
          draft: { ...draft, clips: [...draft.clips, ...clips], updatedAt: Date.now() } } };
      });
      if (appendIssue) throw new Error(appendIssue);
    });
  }
  async loadSequence(projectId: string, planId: string) {
    return this.setup(async (check) => {
      const owner = this.owner(projectId); if (!owner) throw new Error('项目已不存在。');
      const selected = sequenceWorkbenchAssets(owner, planId);
      if (selected.missingSegments.length) throw new Error(`第 ${selected.missingSegments.join('、')} 段尚无可用成片；未改变当前剪辑。`);
      const clips: VideoWorkbenchClip[] = [];
      for (const asset of selected.assets) { check(); clips.push(createWorkbenchClip(asset, await this.probeAsset(projectId, asset.id))); }
      check();
      this.updateDraft(projectId, (draft) => ({ ...draft, clips, sequencePlanId: planId }));
    });
  }
  private assertActive(run: NonNullable<VideoWorkbenchEngine['active']>) {
    if (this.disposed || run.cancelled || this.active !== run || !this.owner(run.job.projectId)?.videoWorkbench?.jobs.some((job) => job.id === run.job.id && job.status === 'running')) throw aborted();
  }
  private async run(projectId: string, input: Omit<VideoWorkbenchJob, 'id' | 'projectId' | 'status' | 'createdAt' | 'updatedAt' | 'resultAssetIds'>,
    work: (run: NonNullable<VideoWorkbenchEngine['active']>) => Promise<ReferenceAsset[]>): Promise<string[]> {
    if (this.busy) throw new Error('已有本地视频处理任务，请先等待或取消。');
    if (!this.owner(projectId)) throw new Error('项目已不存在。');
    const job: VideoWorkbenchJob = { ...structuredClone(input), id: workbenchId('media-job'), projectId, status: 'running', createdAt: Date.now(), updatedAt: Date.now(), resultAssetIds: [] };
    const run = { job, requestId: job.id, cancelled: false };
    this.active = run; this.error = ''; this.progress = undefined;
    this.patch(projectId, (project) => ({ ...project, videoWorkbench: { draft: project.videoWorkbench?.draft || emptyVideoWorkbenchDraft(projectId), jobs: [job, ...(project.videoWorkbench?.jobs || [])] } }));
    this.changed();
    try {
      await this.options.persist?.(); this.assertActive(run);
      const assets = await work(run); this.assertActive(run);
      const ids = assets.map((asset) => asset.id);
      this.patch(projectId, (project) => {
        if (!project.videoWorkbench?.jobs.some((candidate) => candidate.id === job.id && candidate.status === 'running')) return project;
        const resultIds = new Set(assets.map((asset) => asset.id));
        return { ...project, assets: [...assets, ...project.assets.filter((asset) => !resultIds.has(asset.id))].map((asset) => {
          const frame = assets.find((item) => item.sourceVideoAssetId === asset.id && item.referenceRole === 'first-frame' && !item.sourceClipId && Math.abs(item.sourceTimeSec || 0) < 0.000001);
          return frame ? { ...asset, thumbnailAssetId: asset.thumbnailAssetId || frame.id, firstFrameAssetId: asset.firstFrameAssetId || frame.id } : asset;
        }), videoWorkbench: { ...project.videoWorkbench, jobs: project.videoWorkbench.jobs.map((candidate) => candidate.id === job.id ? { ...candidate, status: 'succeeded', updatedAt: Date.now(), resultAssetIds: ids } : candidate) } };
      });
      if (this.options.getState().project.id === projectId) this.options.notify?.(job.kind === 'render' ? '剪辑成片已保存到视频资产库，原片未改变。' : `已保存 ${assets.length} 张抽帧图片，可用于下一段生成。`);
      return ids;
    } catch (cause) {
      const cancelled = run.cancelled || cause instanceof Error && cause.name === 'AbortError';
      const completedCount = this.owner(projectId)?.videoWorkbench?.jobs.find((candidate) => candidate.id === job.id)?.resultAssetIds.length || 0;
      const error = (cancelled ? aborted().message : messageOf(cause)) + (completedCount ? ` 前面已完成的 ${completedCount} 张图片已保留在资产库。` : '');
      this.patch(projectId, (project) => !project.videoWorkbench ? project : ({ ...project, videoWorkbench: { ...project.videoWorkbench,
        jobs: project.videoWorkbench.jobs.map((candidate) => candidate.id === job.id ? { ...candidate, status: cancelled ? 'cancelled' : 'failed', error, updatedAt: Date.now() } : candidate) } }));
      this.error = error; throw cause;
    } finally { if (this.active === run) this.active = undefined; this.changed(); }
  }
  async extractFrames(projectId: string, assetId: string, options: VideoWorkbenchFrameOptions): Promise<string[]> {
    const asset = this.owner(projectId)?.assets.find((item) => item.id === assetId); const source = workbenchSource(asset);
    if (!workbenchVideoAsset(asset!)) throw new Error('只能从视频素材抽帧。');
    return this.run(projectId, { kind: 'extract', name: `${asset!.name} · 抽帧`, sourceAssetId: assetId, sourceChecksum: asset!.checksum, frameOptions: options }, async (run) => {
      const result = await this.bridge().extractWorkbenchFrames({ ...options, jobId: run.requestId, projectId, source, fileName: options.fileName || asset!.name });
      this.assertActive(run);
      return result.frames.map((frame) => frameWorkbenchAsset(frame, asset!, run.job));
    });
  }
  async extractBoundaries(projectId: string, draft = this.draft(projectId)): Promise<string[]> {
    const owner = this.owner(projectId); if (!owner) throw new Error('项目已不存在。');
    const frozenDraft = structuredClone(draft);
    // Boundary extraction depends only on source/ranges. BGM, output size and
    // transitions belong to rendering and must not block independent frames.
    const extractionDefaults = emptyVideoWorkbenchDraft(projectId);
    buildWorkbenchRenderRequest(owner, { ...frozenDraft, output: extractionDefaults.output,
      audio: { ...extractionDefaults.audio, fadeInSec: 0, fadeOutSec: 0 },
      clips: frozenDraft.clips.map((clip) => ({ ...clip, volume: 1, transitionAfter: { type: 'cut', durationSec: 0 } })) }, 'preflight');
    const sources = frozenDraft.clips.map((clip) => structuredClone(owner.assets.find((asset) => asset.id === clip.sourceAssetId)!));
    return this.run(projectId, { kind: 'boundaries', name: `${draft.name} · 衔接帧包`, draft: frozenDraft }, async (run) => {
      const frames: ReferenceAsset[] = [];
      for (let index = 0; index < frozenDraft.clips.length; index += 1) {
        this.assertActive(run); const clip = frozenDraft.clips[index]; const source = sources[index];
        run.requestId = `${run.job.id}-${index}`;
        const result = await this.bridge().extractWorkbenchFrames({ jobId: run.requestId, projectId, source: workbenchSource(source), mode: 'boundaries', inSec: clip.inSec, outSec: clip.outSec, fileName: `第${index + 1}段-${source.name}` });
        this.assertActive(run);
        const completed = result.frames.map((frame) => frameWorkbenchAsset(frame, source, run.job, clip));
        frames.push(...completed);
        // Each video is a native atomic extraction. Persist its completed
        // images immediately so a later video's failure cannot orphan them.
        this.patch(projectId, (project) => !project.videoWorkbench ? project : ({ ...project,
          assets: [...completed, ...project.assets], videoWorkbench: { ...project.videoWorkbench,
            jobs: project.videoWorkbench.jobs.map((candidate) => candidate.id === run.job.id
              ? { ...candidate, resultAssetIds: frames.map((frame) => frame.id), updatedAt: Date.now() } : candidate) } }));
      }
      return frames;
    });
  }
  async renderTimeline(projectId: string, draft = this.draft(projectId)): Promise<string | undefined> {
    const owner = this.owner(projectId); if (!owner) throw new Error('项目已不存在。');
    const frozenDraft = structuredClone(draft);
    if (frozenDraft.audio.bgmAssetId && !frozenDraft.audio.bgmChecksum) frozenDraft.audio.bgmChecksum = owner.assets.find((asset) => asset.id === frozenDraft.audio.bgmAssetId)?.checksum;
    const request = buildWorkbenchRenderRequest(owner, frozenDraft, 'preflight');
    const ids = await this.run(projectId, { kind: 'render', name: draft.name, draft: frozenDraft }, async (run) => {
      const result = await this.bridge().renderWorkbenchTimeline({ ...request, jobId: run.requestId }); this.assertActive(run);
      return [renderedWorkbenchAsset(result, run.job)];
    }); return ids[0];
  }
  async cancel() {
    if (this.setupBusy) { this.setupCancelled = true; this.changed(); return; }
    const run = this.active; if (!run || run.cancelled) return;
    run.cancelled = true; this.changed();
    await this.bridge().cancelWorkbenchJob(run.requestId);
  }
  async retryJob(projectId: string, jobId: string) {
    const job = this.owner(projectId)?.videoWorkbench?.jobs.find((item) => item.id === jobId);
    if (!job || !['failed', 'interrupted', 'cancelled'].includes(job.status)) throw new Error('只有失败、中断或取消的本地任务可以重试。');
    if (job.kind === 'render' && job.draft) { await this.renderTimeline(projectId, job.draft); return; }
    if (job.kind === 'boundaries' && job.draft) { await this.extractBoundaries(projectId, job.draft); return; }
    if (job.kind === 'extract' && job.sourceAssetId && job.frameOptions) {
      const asset = this.owner(projectId)?.assets.find((item) => item.id === job.sourceAssetId);
      if (job.sourceChecksum && asset?.checksum !== job.sourceChecksum) throw new Error('原视频内容已更换，不能按旧快照重试。');
      await this.extractFrames(projectId, job.sourceAssetId, job.frameOptions); return;
    }
    throw new Error('本地处理快照不完整，请重新选择素材。');
  }
  dispose() { this.disposed = true; this.unsubscribe?.(); if (this.active) { this.active.cancelled = true; void this.options.desktop?.cancelWorkbenchJob(this.active.requestId).catch(() => {}); } }
}

export function useVideoWorkbenchController({ state, getCurrentState, setState, ready, notify }: {
  state: AppState; getCurrentState: () => AppState; setState: Update; ready: boolean; notify: (message: string, tone?: 'normal' | 'error') => void;
}): VideoWorkbenchController {
  const current = useRef({ state, getCurrentState, setState, ready, notify }); current.current = { state, getCurrentState, setState, ready, notify };
  const engine = useRef<VideoWorkbenchEngine>(); const [, refresh] = useState(0);
  useEffect(() => {
    if (!ready) return;
    const next = new VideoWorkbenchEngine({ getState: () => current.current.getCurrentState(), setState: (update) => current.current.setState(update),
      desktop: window.lianhuaDesktop, onChange: () => refresh((value) => value + 1),
      persist: async () => { if (!(await saveStateAsync(current.current.getCurrentState())).ok) throw new Error('处理记录保存失败，未启动媒体处理。'); },
      notify: (message, tone) => current.current.notify(message, tone) });
    engine.current = next; next.recoverInterrupted(); void next.refreshStatus();
    return () => { next.dispose(); if (engine.current === next) engine.current = undefined; };
  }, [ready]);
  const get = () => { if (!ready || !engine.current) throw new Error('工作台正在等待正式项目加载。'); return engine.current; };
  const projectId = state.project.id;
  return { draft: state.project.videoWorkbench?.draft || emptyVideoWorkbenchDraft(projectId), jobs: state.project.videoWorkbench?.jobs || [],
    status: engine.current?.status, busy: engine.current?.busy || false, error: engine.current?.error || '', progress: engine.current?.progress,
    probes: engine.current?.probesFor(projectId) || {}, refreshStatus: () => get().refreshStatus(),
    updateDraft: (update) => get().updateDraft(projectId, update), probeAsset: (id) => get().probeAsset(projectId, id), importFiles: (files) => get().importFiles(projectId, files),
    addAssets: (ids) => get().addAssets(projectId, ids), loadSequence: (id) => get().loadSequence(projectId, id), extractFrames: (id, options) => get().extractFrames(projectId, id, options),
    extractBoundaries: (draft) => get().extractBoundaries(projectId, draft), renderTimeline: () => get().renderTimeline(projectId), cancel: () => get().cancel(), retryJob: (id) => get().retryJob(projectId, id) };
}
