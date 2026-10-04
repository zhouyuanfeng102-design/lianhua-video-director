import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { ArrowDown, ArrowUp, CheckCircle2, ChevronLeft, ChevronRight, Film, FolderOpen, GripVertical, Image as ImageIcon, Layers, Link2, Music2, Pause, Play, Plus, RefreshCw, Scissors, Trash2, Upload, X } from 'lucide-react';
import { assetPreviewUrl } from '../media';
import type { Project, ReferenceAsset } from '../types';
import type { VideoDirectorLaunchRequest } from '../videoDirectorDraft';
import type { VideoWorkbenchController } from '../useVideoWorkbenchController';
import type { WorkbenchFrameMode } from '../videoWorkbenchTypes';
import { useWorkbenchNamePages } from '../useWorkbenchNamePages';
import {
  appendWorkbenchVideoSelection, normalizeWorkbenchVideoSelection, orderedWorkbenchSelection, selectableWorkbenchVideo,
  selectWorkbenchVideoResults, workbenchAudioAsset as isAudio, workbenchVideoAsset as isVideo, workbenchId,
  type WorkbenchVideoSelection,
} from '../videoWorkbench';
import '../videoWorkbench.css';

export interface VideoWorkbenchViewProps {
  project: Project;
  controller: VideoWorkbenchController;
  onOpenVideoDirector: (request: Omit<VideoDirectorLaunchRequest, 'id'>) => void;
  onOpenAssets: (kind: 'image' | 'video' | 'audio') => void;
}

const formatTime = (value: number | undefined) => {
  if (value === undefined || !Number.isFinite(value)) return '待读取';
  const minutes = Math.floor(Math.max(0, value) / 60);
  return `${minutes}:${(Math.max(0, value) % 60).toFixed(2).padStart(5, '0')}`;
};
const thumbnailFor = (asset: ReferenceAsset | undefined, assets: ReferenceAsset[]) => {
  if (!asset) return '';
  const thumbnail = assets.find((item) => item.id === (asset.thumbnailAssetId || asset.firstFrameAssetId));
  return thumbnail ? assetPreviewUrl(thumbnail) : '';
};
const frameRoleLabel = (asset: ReferenceAsset) => asset.referenceRole === 'first-frame' ? '首帧' : asset.referenceRole === 'last-frame' ? '尾帧' : '指定帧';

function StaticThumbnail({ asset, assets }: { asset?: ReferenceAsset; assets: ReferenceAsset[] }) {
  const src = thumbnailFor(asset, assets);
  return <span className="vwb-thumb">{src ? <img src={src} alt={`${asset?.name || '视频'}缩略图`} loading="lazy" /> : <Film size={25} />}</span>;
}

type WorkbenchTab = 'edit' | 'frames' | 'jobs';

/** Fit complete rows into the available panel. Pagination, never clipping, handles overflow. */
function usePagedItems<T>(items: T[]) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [capacity, setCapacity] = useState(1);
  const [requestedPage, setRequestedPage] = useState(0);
  const pendingIndex = useRef<number | undefined>(undefined);
  const measureRef = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const rowHeight = Number.parseFloat(style.gridAutoRows) || 64;
      const gap = Number.parseFloat(style.rowGap) || 0;
      const height = element.getBoundingClientRect().height - (Number.parseFloat(style.paddingTop) || 0) - (Number.parseFloat(style.paddingBottom) || 0) - (Number.parseFloat(style.borderTopWidth) || 0) - (Number.parseFloat(style.borderBottomWidth) || 0);
      const columns = Math.max(1, style.gridTemplateColumns.split(' ').filter(Boolean).length);
      const nextCapacity = Math.max(1, Math.floor((height + gap) / (rowHeight + gap))) * columns;
      setCapacity(nextCapacity);
      if (pendingIndex.current !== undefined) {
        setRequestedPage(Math.floor(pendingIndex.current / nextCapacity));
        pendingIndex.current = undefined;
      }
    };
    measureRef.current = measure;
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    const scale = new MutationObserver(measure);
    const shell = element.closest('.app-shell');
    if (shell) scale.observe(shell, { attributes: true, attributeFilter: ['style', 'data-ui-font-scale'] });
    return () => { resize.disconnect(); scale.disconnect(); measureRef.current = undefined; };
  }, [element]);
  useLayoutEffect(() => { measureRef.current?.(); }, [items.length]);
  const pageCount = Math.max(1, Math.ceil(items.length / capacity));
  const page = Math.min(requestedPage, pageCount - 1);
  useEffect(() => { if (requestedPage !== page) setRequestedPage(page); }, [page, requestedPage]);
  return {
    listRef: setElement, page, pageCount, capacity,
    setPage: (nextPage: number) => { pendingIndex.current = undefined; setRequestedPage(Math.max(0, nextPage)); },
    revealIndex: (index: number) => { pendingIndex.current = Math.max(0, index); measureRef.current?.(); },
    items: items.slice(page * capacity, (page + 1) * capacity),
  };
}

function Pagination({ label, total, page, pageCount, onPage }: { label: string; total: number; page: number; pageCount: number; onPage: (page: number) => void }) {
  return <nav className="vwb-pagination" aria-label={`${label}分页`}>
    <span>{total} 项</span>
    <div>
      <button type="button" className="vwb-icon-button" aria-label={`${label}上一页`} disabled={page === 0} onClick={() => onPage(page - 1)}><ChevronLeft size={13} /></button>
      <select aria-label={`${label}页码`} value={page} disabled={pageCount === 1} onChange={(event) => onPage(Number(event.target.value))}>{Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>第 {index + 1} / {pageCount} 页</option>)}</select>
      <button type="button" className="vwb-icon-button" aria-label={`${label}下一页`} disabled={page >= pageCount - 1} onClick={() => onPage(page + 1)}><ChevronRight size={13} /></button>
    </div>
  </nav>;
}

function messagePages(text: string) {
  // Bound both characters and explicit lines so even long diagnostics stay readable without a scroll box.
  const pages: string[] = [];
  let current = '';
  let lines = 1;
  for (const character of text) {
    if (current.length >= 240 || (character === '\n' && lines >= 6)) { pages.push(current); current = ''; lines = 1; }
    current += character;
    if (character === '\n') lines += 1;
  }
  if (current || !pages.length) pages.push(current);
  return pages;
}

/** Always visible beneath the timeline: compact real controls, not a scaled screenshot or another tab. */
function WorkbenchOutputSettings({ draft, controller, busy, audioAssets, onOpenAssets, onHelp }: {
  draft: VideoWorkbenchController['draft']; controller: VideoWorkbenchController; busy: boolean;
  audioAssets: ReferenceAsset[];
  onOpenAssets: VideoWorkbenchViewProps['onOpenAssets']; onHelp: () => void;
}) {
  return <section className="vwb-inline-output" aria-label="输出与声音">
    <div className="vwb-panel-heading"><h3><Music2 size={13} />输出与声音</h3><div className="vwb-actions"><button type="button" className="vwb-help-button" onClick={() => onOpenAssets('audio')}>音频资产库</button><button type="button" className="vwb-help-button" onClick={onHelp}>输出说明</button></div></div>
    <div className="vwb-output-columns">
      <section className="vwb-setting-group" aria-label="画面输出设置">
        <label className="vwb-label">输出文件名<input value={draft.output.fileName} disabled={busy} placeholder="剪辑成片.mp4" onChange={(event) => controller.updateDraft((current) => ({ ...current, output: { ...current.output, fileName: event.target.value } }))} /></label>
        <div className="vwb-fields vwb-output-format"><label className="vwb-label">输出尺寸<select disabled={busy} value={draft.output.width + 'x' + draft.output.height} onChange={(event) => { const [width, height] = event.target.value.split('x').map(Number); controller.updateDraft((current) => ({ ...current, output: { ...current.output, width, height } })); }}><option value="1920x1080">横屏 1920 × 1080</option><option value="1280x720">横屏 1280 × 720</option><option value="1080x1920">竖屏 1080 × 1920</option><option value="720x1280">竖屏 720 × 1280</option><option value="1080x1080">方形 1080 × 1080</option>{![ '1920x1080', '1280x720', '1080x1920', '720x1280', '1080x1080' ].includes(draft.output.width + 'x' + draft.output.height) && <option value={draft.output.width + 'x' + draft.output.height}>{draft.output.width} × {draft.output.height}</option>}</select></label>
          <label className="vwb-label">帧率<select disabled={busy} value={draft.output.fps} onChange={(event) => controller.updateDraft((current) => ({ ...current, output: { ...current.output, fps: Number(event.target.value) } }))}>{[24,25,30,50,60].map((fps) => <option key={fps} value={fps}>{fps} fps</option>)}</select></label></div>
        <div className="vwb-fields"><label className="vwb-label" title="画面淡入，单位秒"><span>画淡入</span><input aria-label="画面淡入（秒）" type="number" min="0" max="5" step="0.1" disabled={busy} value={draft.output.fadeInSec} onChange={(event) => controller.updateDraft((current) => ({ ...current, output: { ...current.output, fadeInSec: Number(event.target.value) } }))} /></label><label className="vwb-label" title="画面淡出，单位秒"><span>画淡出</span><input aria-label="画面淡出（秒）" type="number" min="0" max="5" step="0.1" disabled={busy} value={draft.output.fadeOutSec} onChange={(event) => controller.updateDraft((current) => ({ ...current, output: { ...current.output, fadeOutSec: Number(event.target.value) } }))} /></label></div>
      </section>
      <section className="vwb-setting-group" aria-label="声音设置">
        <label className="vwb-label">背景音乐<select disabled={busy} value={draft.audio.bgmAssetId || ''} onChange={(event) => controller.updateDraft((current) => ({ ...current, audio: { ...current.audio, bgmAssetId: event.target.value || undefined, bgmChecksum: undefined } }))}><option value="">不添加 BGM（保留原声）</option>{audioAssets.map((asset) => <option key={asset.id} value={asset.id} disabled={asset.missing}>{asset.name}{asset.missing ? ' · 文件缺失' : ''}</option>)}</select></label>
        <div className="vwb-audio-mix"><label className="vwb-label">BGM 音量 %<input aria-label="BGM 音量（原始音量的 %）" type="number" min="0" max="50" step="1" disabled={busy || !draft.audio.bgmAssetId} value={Math.round(draft.audio.bgmVolume * 100)} onChange={(event) => controller.updateDraft((current) => ({ ...current, audio: { ...current.audio, bgmVolume: Number(event.target.value) / 100 } }))} /></label>
          <label className="vwb-check vwb-ducking"><input type="checkbox" disabled={busy || !draft.audio.bgmAssetId} checked={draft.audio.ducking} onChange={(event) => controller.updateDraft((current) => ({ ...current, audio: { ...current.audio, ducking: event.target.checked } }))} /><span>原声优先<br />自动压低 BGM</span></label></div>
        <div className="vwb-fields"><label className="vwb-label" title="声音淡入，单位秒"><span>声淡入</span><input aria-label="声音淡入（秒）" type="number" min="0" max="5" step="0.1" disabled={busy} value={draft.audio.fadeInSec} onChange={(event) => controller.updateDraft((current) => ({ ...current, audio: { ...current.audio, fadeInSec: Number(event.target.value) } }))} /></label><label className="vwb-label" title="声音淡出，单位秒"><span>声淡出</span><input aria-label="声音淡出（秒）" type="number" min="0" max="5" step="0.1" disabled={busy} value={draft.audio.fadeOutSec} onChange={(event) => controller.updateDraft((current) => ({ ...current, audio: { ...current.audio, fadeOutSec: Number(event.target.value) } }))} /></label></div>
      </section>
    </div>
  </section>;
}

export function VideoWorkbenchView({ project, controller, onOpenVideoDirector, onOpenAssets }: VideoWorkbenchViewProps) {
  const { draft, busy: engineBusy, status, progress } = controller;
  const [addingSources, setAddingSources] = useState<{ completed: number; total: number }>();
  const busy = engineBusy || Boolean(addingSources);
  const [videoSelection, setVideoSelection] = useState<WorkbenchVideoSelection>(() => ({ projectId: project.id, assetIds: [] }));
  const videos = useMemo(() => project.assets.filter(isVideo).sort((a, b) => b.createdAt - a.createdAt), [project.assets]);
  const audioAssets = useMemo(() => project.assets.filter(isAudio), [project.assets]);
  const [sourceId, setSourceId] = useState('');
  const [selectedClipId, setSelectedClipId] = useState('');
  const [search, setSearch] = useState('');
  const [planId, setPlanId] = useState(draft.sequencePlanId || project.sequencePlans[0]?.id || '');
  const [frameMode, setFrameMode] = useState<WorkbenchFrameMode>('last');
  const [frameTime, setFrameTime] = useState(0);
  const [frameNumber, setFrameNumber] = useState(1);
  const [frameCount, setFrameCount] = useState(6);
  const [useClipRange, setUseClipRange] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [targetStoryboardId, setTargetStoryboardId] = useState('');
  const [useAsFirstFrame, setUseAsFirstFrame] = useState(true);
  const [resultSourceFilter, setResultSourceFilter] = useState<'current' | 'all'>('current');
  const [framePreview, setFramePreview] = useState<ReferenceAsset>();
  const [localError, setLocalError] = useState('');
  const [localNotice, setLocalNotice] = useState('');
  const [draggedClipId, setDraggedClipId] = useState('');
  const [dragOverClipId, setDragOverClipId] = useState('');
  const [timelinePreview, setTimelinePreview] = useState(false);
  const [previewClipIndex, setPreviewClipIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('edit');
  const [messageDialog, setMessageDialog] = useState<{ title: string; text: string }>();
  const [messagePage, setMessagePage] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const advancing = useRef(false);
  const dialogCloseRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const projectScope = useRef({ projectId: project.id });
  if (projectScope.current.projectId !== project.id) projectScope.current = { projectId: project.id };
  const currentProject = useRef(project); currentProject.current = project;
  const currentDraftId = useRef(draft.id); currentDraftId.current = draft.id;
  const addingRun = useRef<{ scope: { projectId: string }; cancelled: boolean }>();

  const source = videos.find((asset) => asset.id === sourceId);
  const selectedClip = draft.clips.find((clip) => clip.id === selectedClipId);
  const previewClip = timelinePreview ? draft.clips[previewClipIndex] : selectedClip?.sourceAssetId === sourceId ? selectedClip : undefined;
  const previewSource = timelinePreview ? videos.find((asset) => asset.id === previewClip?.sourceAssetId) : source;
  const probe = source ? controller.probes[source.id] : undefined;
  const sourceDuration = probe?.durationSec || source?.durationSec;
  const extractRange = useClipRange && selectedClip?.sourceAssetId === sourceId ? selectedClip : undefined;
  const totalDuration = draft.clips.reduce((total, clip, index) => total + Math.max(0, clip.outSec - clip.inSec) - (index < draft.clips.length - 1 && clip.transitionAfter.type === 'crossfade' ? clip.transitionAfter.durationSec : 0), 0);
  const frames = useMemo(() => project.assets.filter((asset) => asset.sourceVideoAssetId && !isVideo(asset) && !isAudio(asset)).sort((a, b) => b.createdAt - a.createdAt), [project.assets]);
  const filteredFrames = frames.filter((asset) => resultSourceFilter === 'all' || asset.sourceVideoAssetId === sourceId);
  const selectedPlan = project.sequencePlans.find((plan) => plan.id === planId);
  const sourceStoryboardId = source?.sourceStoryboardId || source?.videoSourceTask?.storyboardId;
  const sourceSegment = selectedPlan?.segments.find((segment) => segment.storyboardId === sourceStoryboardId);
  const nextSegment = sourceSegment && selectedPlan?.segments.find((segment) => segment.index === sourceSegment.index + 1);
  const filteredVideos = videos.filter((asset) => `${asset.name} ${asset.tags.join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const validVideoSelection = normalizeWorkbenchVideoSelection(videoSelection, project.id, videos);
  const selectedVideoIds = new Set(validVideoSelection.assetIds);
  const selectableFilteredVideos = filteredVideos.filter(selectableWorkbenchVideo);
  const allFilteredVideosSelected = selectableFilteredVideos.length > 0 && selectableFilteredVideos.every((asset) => selectedVideoIds.has(asset.id));
  const someFilteredVideosSelected = selectableFilteredVideos.some((asset) => selectedVideoIds.has(asset.id));
  const hasError = localError || controller.error;
  const available = Boolean(status?.available);
  const selectedRangeInvalid = Boolean(extractRange && (!Number.isFinite(extractRange.inSec) || !Number.isFinite(extractRange.outSec) || extractRange.inSec < 0 || extractRange.outSec <= extractRange.inSec || (sourceDuration && extractRange.outSec > sourceDuration + .01)));
  const sourcePages = useWorkbenchNamePages(filteredVideos);
  const clipPages = usePagedItems(draft.clips);
  const framePages = usePagedItems(filteredFrames);
  const jobPages = usePagedItems([...controller.jobs].sort((a, b) => b.createdAt - a.createdAt));
  const selectedClipIndex = draft.clips.findIndex((clip) => clip.id === selectedClipId);
  const selectedClipAsset = videos.find((asset) => asset.id === selectedClip?.sourceAssetId);
  const selectedClipDuration = selectedClip && (controller.probes[selectedClip.sourceAssetId]?.durationSec || selectedClipAsset?.durationSec);
  const clipError = selectedClip && (!selectedClipAsset || selectedClipAsset.missing ? '素材缺失：请移除此片段或在资产库重新关联文件。' : selectedClip.inSec < 0 || selectedClip.outSec <= selectedClip.inSec || Boolean(selectedClipDuration && selectedClip.outSec > selectedClipDuration + .01) ? `裁剪区间无效：需满足 0 ≤ 入点 < 出点${selectedClipDuration ? ` ≤ ${selectedClipDuration.toFixed(2)} 秒` : ''}。` : '');
  const detailPages = useMemo(() => messagePages(messageDialog?.text || ''), [messageDialog]);
  const footerMessage = hasError || (!available ? status?.message || '正在检查本地视频处理引擎…' : localNotice || progress?.message || '剪辑方案自动保存；原视频保留，抽帧和成片保存到当前项目。');

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; if (addingRun.current) addingRun.current.cancelled = true; };
  }, []);
  useEffect(() => {
    setVideoSelection((selection) => normalizeWorkbenchVideoSelection(selection, project.id, videos));
    if (addingRun.current && addingRun.current.scope !== projectScope.current) addingRun.current.cancelled = true;
  }, [project.id, videos]);

  useEffect(() => {
    if (!sourceId && videos[0]) setSourceId(videos[0].id);
    else if (sourceId && !videos.some((asset) => asset.id === sourceId)) setSourceId(videos[0]?.id || '');
  }, [sourceId, videos]);
  useEffect(() => {
    if (selectedClipId && !draft.clips.some((clip) => clip.id === selectedClipId)) setSelectedClipId('');
  }, [draft.clips, selectedClipId]);
  useEffect(() => {
    setCurrentTime(0);
    if (source && !source.missing && source.relativePath && available) {
      void controller.probeAsset(source.id).catch((error: unknown) => setLocalError(error instanceof Error ? error.message : '读取视频信息失败'));
    }
  // The controller caches probes; only source identity or backend readiness should initiate a read.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, source?.relativePath, source?.checksum, available]);
  useEffect(() => {
    if (!previewClip || !videoRef.current) return;
    advancing.current = false;
    const video = videoRef.current;
    if (video.readyState >= 1) {
      video.currentTime = previewClip.inSec;
      video.volume = Math.min(1, Math.max(0, previewClip.volume));
      if (timelinePreview) void video.play().catch(() => setLocalError('预览未自动播放，请点击播放器中的播放按钮。'));
    }
  }, [previewClip?.id, timelinePreview]);
  useEffect(() => {
    if (!framePreview && !messageDialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogCloseRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setFramePreview(undefined); setMessageDialog(undefined); }
      if (event.key === 'Tab') {
        const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), [href], [tabindex="0"]') || [])];
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [framePreview, messageDialog]);

  const showMessage = (title: string, text: string) => { setMessagePage(0); setMessageDialog({ title, text }); };

  const runAction = async (operation: () => Promise<unknown>, success?: string) => {
    setLocalError(''); setLocalNotice('');
    try { await operation(); if (success) setLocalNotice(success); }
    catch (error) { setLocalError(error instanceof Error ? error.message : '操作失败，请重试。'); }
  };
  const addVideoSources = async (assetIds: string[], clearSuccessfulSelection: boolean) => {
    if (addingRun.current || busy || !available || !assetIds.length) return;
    const run = { scope: projectScope.current, cancelled: false };
    const draftId = draft.id;
    addingRun.current = run; setAddingSources({ completed: 0, total: assetIds.length }); setLocalError(''); setLocalNotice('');
    try {
      const result = await appendWorkbenchVideoSelection({ assetIds,
        getAssets: () => currentProject.current.assets,
        isCurrent: () => mountedRef.current && projectScope.current === run.scope && currentDraftId.current === draftId && !run.cancelled,
        addAsset: (assetId) => controller.addAssets([assetId]),
        onProgress: (completed, total) => { if (mountedRef.current && projectScope.current === run.scope) setAddingSources({ completed, total }); },
      });
      if (!mountedRef.current || projectScope.current !== run.scope) return;
      if (clearSuccessfulSelection) {
        const added = new Set(result.addedIds);
        setVideoSelection((selection) => normalizeWorkbenchVideoSelection({ ...selection,
          assetIds: selection.assetIds.filter((id) => !added.has(id)) }, project.id, currentProject.current.assets));
      }
      const summary = `已添加 ${result.addedIds.length} / ${result.requestedIds.length} 个视频到时间线末尾；原片段未覆盖。`
        + (result.failed.length ? `失败 ${result.failed.length} 个。` : '')
        + (result.unattemptedIds.length ? `已停止，剩余 ${result.unattemptedIds.length} 个未处理。` : '')
        + (clearSuccessfulSelection && (result.failed.length || result.unattemptedIds.length) ? '未成功且仍有效的素材保留勾选；重试会追加到末尾，可用上下移调整顺序。' : '')
        + (result.failed.length ? '\n' + result.failed.map((failure) => `${failure.name}：${failure.message}`).join('\n') : '');
      if (result.failed.length) setLocalError(summary); else setLocalNotice(summary);
    } catch (error) {
      if (mountedRef.current && projectScope.current === run.scope) setLocalError(error instanceof Error ? error.message : '添加失败，未成功的选择保留，请重试。');
    } finally {
      if (addingRun.current === run) { addingRun.current = undefined; if (mountedRef.current) setAddingSources(undefined); }
    }
  };
  const chooseSource = (asset: ReferenceAsset, clipId = '') => {
    setTimelinePreview(false); videoRef.current?.pause();
    setSourceId(asset.id); setSelectedClipId(clipId); setLocalError('');
  };
  const changeClip = (clipId: string, update: Partial<(typeof draft.clips)[number]>) => {
    controller.updateDraft((current) => ({ ...current, clips: current.clips.map((clip) => clip.id === clipId ? { ...clip, ...update } : clip) }));
  };
  const moveClip = (clipId: string, targetIndex: number) => {
    setTimelinePreview(false); videoRef.current?.pause();
    controller.updateDraft((current) => {
      const index = current.clips.findIndex((clip) => clip.id === clipId);
      if (index < 0 || targetIndex < 0 || targetIndex >= current.clips.length) return current;
      const clips = [...current.clips];
      const [moving] = clips.splice(index, 1); clips.splice(targetIndex, 0, moving);
      return { ...current, clips };
    });
  };
  const splitClipAtPlayhead = (clipId: string) => {
    const clip = draft.clips.find((item) => item.id === clipId);
    const time = Math.round(currentTime * 1000) / 1000;
    const frameDuration = 1 / (probe?.fps || 25);
    if (!clip || time < clip.inSec + frameDuration || time > clip.outSec - frameDuration) { setLocalError('请将播放头放在当前片段内部，分割后两段都至少保留一帧。'); return; }
    controller.updateDraft((current) => {
      const clips = current.clips.flatMap((item) => item.id !== clipId ? [item] : [
        { ...item, outSec: time, transitionAfter: { type: 'cut' as const, durationSec: .3 } },
        { ...item, id: workbenchId('clip'), inSec: time },
      ]);
      return { ...current, clips: clips.map((item, index) => {
        const next = clips[index + 1];
        if (!next || item.transitionAfter.type !== 'crossfade') return item;
        const durationSec = Math.min(item.transitionAfter.durationSec, (item.outSec - item.inSec) / 2, (next.outSec - next.inSec) / 2);
        return { ...item, transitionAfter: { ...item.transitionAfter, durationSec } };
      }) };
    });
    setLocalNotice('已按当前画面分割为两个片段，原视频未修改。');
  };
  const importFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files || [])]; event.target.value = '';
    if (files.length) void runAction(() => controller.importFiles(files));
  };
  const extract = () => {
    if (!source) return;
    if (frameMode === 'frame' && (!Number.isInteger(frameNumber) || frameNumber < 1)) { setLocalError('帧号从第 1 帧开始，请输入正整数。'); return; }
    if (frameMode === 'uniform' && (!Number.isInteger(frameCount) || frameCount < 2 || frameCount > 60)) { setLocalError('均匀抽帧数量请填写 2–60 之间的整数。'); return; }
    void runAction(() => controller.extractFrames(source.id, {
      mode: frameMode,
      ...(frameMode === 'time' ? { timeSec: frameTime } : {}),
      ...(frameMode === 'frame' ? { frameIndex: frameNumber - 1 } : {}),
      ...(frameMode === 'uniform' ? { count: frameCount } : {}),
      ...(extractRange ? { inSec: extractRange.inSec, outSec: extractRange.outSec } : {}),
    }));
  };
  const sendFrame = (asset: ReferenceAsset) => {
    if (asset.missing || !assetPreviewUrl(asset)) { setLocalError('此抽帧图片文件缺失，请重新抽帧或到资产库重新关联文件。'); return; }
    const destination = targetStoryboardId || undefined;
    const targetLabel = project.storyboards.find((board) => board.id === destination)?.sourceStoryTitle || selectedPlan?.segments.find((segment) => segment.storyboardId === destination)?.title || '视频导演台草稿';
    if (!window.confirm(`将“${asset.name}”作为${useAsFirstFrame ? '首帧参考' : '构图参考'}带入“${targetLabel}”？\n不会提交生成，也不会覆盖原分镜参考图。请在视频导演台确认参考图后再生成。`)) return;
    onOpenVideoDirector({
      ...(destination ? { storyboardId: destination } : {}),
      assetIds: [asset.id],
      referenceRoleOverrides: { [asset.id]: useAsFirstFrame ? 'first-frame' : 'composition' },
    });
  };
  const advancePreview = () => {
    if (!timelinePreview || advancing.current) return;
    advancing.current = true;
    if (previewClipIndex + 1 < draft.clips.length) setPreviewClipIndex((index) => index + 1);
    else { videoRef.current?.pause(); setTimelinePreview(false); setLocalNotice('时间线顺序预览结束。转场和混音效果请在导出成片中确认。'); }
  };
  const startTimelinePreview = () => {
    if (!draft.clips.length) return;
    const invalid = draft.clips.find((clip) => {
      const asset = videos.find((video) => video.id === clip.sourceAssetId);
      return !asset || asset.missing || !assetPreviewUrl(asset) || clip.outSec <= clip.inSec;
    });
    if (invalid) { setLocalError('时间线包含缺失视频或无效裁剪区间，请先修复对应片段。'); return; }
    setLocalError(''); setPreviewClipIndex(0); setTimelinePreview(true);
  };

  return <div className="video-workbench-view">
    <header className="vwb-heading">
      <div className="vwb-heading-copy"><h1>视频工作台</h1><p>剪辑、抽帧与衔接，当前页完成。</p></div>
      <div className="vwb-actions">
        <button type="button" className="btn small" onClick={() => onOpenAssets('video')}><FolderOpen size={14} />视频资产库</button>
        <button type="button" className="btn small" disabled={busy} onClick={() => fileInput.current?.click()}><Upload size={14} />导入视频 / 音频</button>
        <input ref={fileInput} type="file" accept="video/*,audio/*,.mp4,.mov,.mkv,.webm,.avi,.mp3,.wav,.m4a,.aac,.flac" multiple hidden onChange={importFiles} />
      </div>
    </header>

    <div className="vwb-tabs" role="tablist" aria-label="视频工作台功能">
      {([
        ['edit', '剪辑拼接', Scissors],
        ['frames', '抽帧衔接', Link2],
        ['jobs', '处理记录', Film],
      ] as const).map(([id, label, Icon], index, tabs) => <button key={id} type="button" id={'vwb-tab-' + id} className={'vwb-tab' + (activeTab === id ? ' active' : '')} role="tab" aria-selected={activeTab === id} aria-controls={'vwb-pane-' + id} tabIndex={activeTab === id ? 0 : -1} onClick={() => setActiveTab(id)} onKeyDown={(event) => {
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault(); setActiveTab(tabs[next][0]); document.getElementById('vwb-tab-' + tabs[next][0])?.focus();
      }}><Icon size={15} /><span>{label}</span>{id === 'jobs' && <small>{controller.jobs.length}</small>}</button>)}
    </div>

    <div className="vwb-layout">
      <aside className="vwb-library-column">
        <section className="vwb-panel vwb-sources" aria-label="视频素材">
          <div className="vwb-panel-heading"><h2><Film size={15} />视频素材</h2><span className="vwb-count">{videos.length} 个</span></div>
          <input className="vwb-search" type="search" aria-label="搜索视频素材" placeholder="搜索视频名称 / 标签" value={search} onChange={(event) => { setSearch(event.target.value); sourcePages.setPage(0); }} />
          <div className="vwb-source-selection" aria-label="视频素材多选操作">
            <label className="vwb-check" title="选择当前筛选条件下的全部有效视频，包含其他分页"><input type="checkbox" aria-label="全选筛选结果（跨全部分页）" checked={allFilteredVideosSelected} aria-checked={someFilteredVideosSelected && !allFilteredVideosSelected ? 'mixed' : allFilteredVideosSelected} ref={(element) => { if (element) element.indeterminate = someFilteredVideosSelected && !allFilteredVideosSelected; }} disabled={busy || !selectableFilteredVideos.length} onChange={(event) => {
              const checked = event.target.checked;
              setVideoSelection((selection) => selectWorkbenchVideoResults(selection, project.id, videos, filteredVideos.map((asset) => asset.id), checked));
              setLocalNotice('全选作用于筛选结果的全部分页；添加时按素材清单从上到下（新到旧）追加，不覆盖已有时间线。');
            }} /><span>全选筛选结果<small>跨全部分页</small></span></label>
            <button type="button" className="btn small ghost" disabled={busy || !selectedVideoIds.size} onClick={() => setVideoSelection({ projectId: project.id, assetIds: [] })}>取消选择</button>
            <button type="button" className="btn small vwb-add-selected" title="按当前素材清单从上到下（新到旧）追加；包括其他分页已选素材，保留已有时间线" disabled={busy || !available || !selectedVideoIds.size} onClick={() => { void addVideoSources(orderedWorkbenchSelection(validVideoSelection, project.id, videos), true); }}>{addingSources ? `添加中 ${addingSources.completed}/${addingSources.total}` : `添加已选（${selectedVideoIds.size}）`}</button>
          </div>
          <div ref={sourcePages.listRef} className="vwb-source-list">
            {sourcePages.items.map((asset) => <article key={asset.id} className={'vwb-source' + (sourcePages.wideNames.has(asset.id) ? ' vwb-source--full-width-name' : '') + (sourceId === asset.id ? ' selected' : '') + (selectedVideoIds.has(asset.id) ? ' checked' : '') + (asset.missing ? ' missing' : '')}>
              <input className="vwb-source-check" type="checkbox" aria-label={'选择素材 ' + asset.name} checked={selectedVideoIds.has(asset.id)} disabled={busy || !selectableWorkbenchVideo(asset)} onChange={(event) => { const checked = event.target.checked; setVideoSelection((selection) => selectWorkbenchVideoResults(selection, project.id, videos, [asset.id], checked)); setLocalNotice('已选素材按清单从上到下（新到旧）追加；预览、单独添加和多选勾选互不影响。'); }} />
              <button type="button" className="vwb-source-select vwb-source-cover" aria-label={'预览视频 ' + asset.name} onClick={() => chooseSource(asset)}><StaticThumbnail asset={asset} assets={project.assets} /></button>
              <button type="button" className="vwb-source-select vwb-source-copy" onClick={() => chooseSource(asset)} aria-pressed={sourceId === asset.id} title={asset.name}><strong style={sourcePages.nameSizes[asset.id] ? { fontSize: sourcePages.nameSizes[asset.id] } : undefined}>{asset.name}</strong><small>{asset.missing ? '原文件缺失' : formatTime(controller.probes[asset.id]?.durationSec || asset.durationSec) + ' · ' + (asset.width || '?') + '×' + (asset.height || '?')}</small></button>
              {sourcePages.wideNames.has(asset.id) && <small className="vwb-source-extra-meta">{asset.missing ? '原文件缺失' : formatTime(controller.probes[asset.id]?.durationSec || asset.durationSec) + ' · ' + (asset.width || '?') + '×' + (asset.height || '?')}</small>}
              <button type="button" className="vwb-icon-button vwb-source-add" title="单独加入时间线，不改变多选勾选" aria-label={'加入时间线 ' + asset.name} disabled={busy || !selectableWorkbenchVideo(asset) || !available} onClick={() => { void addVideoSources([asset.id], false); }}><Plus size={15} /></button>
            </article>)}
            {!filteredVideos.length && <div className="vwb-empty"><Film size={25} /><span>{videos.length ? '没有符合搜索条件的视频' : '导入视频，或到视频导演台生成。'}</span>{!videos.length && <button type="button" className="btn small" onClick={() => onOpenVideoDirector({})}>打开视频导演台</button>}</div>}
          </div>
          <Pagination label="视频素材" total={filteredVideos.length} page={sourcePages.page} pageCount={sourcePages.pageCount} onPage={sourcePages.setPage} />
        </section>

        <section className="vwb-panel vwb-preview-panel" aria-label="视频预览">
          <div className="vwb-panel-heading"><h2><Play size={14} />{timelinePreview ? '顺序预览 · 第 ' + (previewClipIndex + 1) + ' 段' : '素材预览'}</h2><div className="vwb-actions">{timelinePreview ? <button type="button" className="btn small" onClick={() => { videoRef.current?.pause(); setTimelinePreview(false); }}><Pause size={12} />停止预览</button> : <button type="button" className="btn small" disabled={!draft.clips.length} onClick={startTimelinePreview}><Play size={12} />顺序预览</button>}</div></div>
          {previewSource && !previewSource.missing && assetPreviewUrl(previewSource) ? <video
            ref={videoRef} className="vwb-player" controls preload="metadata" playsInline
            key={previewSource.id + ':' + (timelinePreview ? previewClip?.id : 'source')}
            src={assetPreviewUrl(previewSource)} poster={thumbnailFor(previewSource, project.assets) || undefined}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              if (previewClip) video.currentTime = previewClip.inSec;
              if (timelinePreview) { advancing.current = false; video.volume = Math.min(1, Math.max(0, previewClip?.volume ?? 1)); void video.play().catch(() => setLocalError('请点击播放器中的播放按钮开始预览。')); }
            }}
            onTimeUpdate={(event) => { setCurrentTime(event.currentTarget.currentTime); if (timelinePreview && previewClip && event.currentTarget.currentTime >= previewClip.outSec - .025) advancePreview(); }}
            onEnded={advancePreview}
            onError={() => setLocalError('预览无法读取此视频。请检查原文件是否存在；部分编码浏览器不能预览，仍可尝试本地处理引擎抽帧或导出。')}
          /> : <div className="vwb-empty vwb-preview-empty"><Film size={30} /><span>{previewSource?.missing ? '视频文件缺失，请到资产库重新关联。' : '选择上方视频进行预览。'}</span></div>}
          <div className="vwb-preview-info"><strong title={previewSource?.name}>{previewSource?.name || '未选择视频'}</strong><span>{formatTime(currentTime)} / {formatTime(previewSource?.durationSec || (previewSource && controller.probes[previewSource.id]?.durationSec))}</span></div>
          <button type="button" className="vwb-help-button" onClick={() => showMessage('顺序预览说明', '顺序预览用于检查片段顺序与裁剪点；交叉溶解、淡入淡出和 BGM 混音以导出成片为准。原始视频不会被修改。')}>顺序预览不含转场与混音 · 查看说明</button>
        </section>
      </aside>

      {activeTab === 'edit' && <section className="vwb-panel vwb-tab-pane vwb-edit-pane" id="vwb-pane-edit" role="tabpanel" aria-labelledby="vwb-tab-edit" tabIndex={0}>
        <div className="vwb-panel-heading"><h2><Scissors size={15} />剪辑时间线</h2><div className="vwb-actions"><span className="vwb-count">{draft.clips.length} 段 · 约 {formatTime(Math.max(0, totalDuration))}</span><button type="button" className="btn small ghost" disabled={busy || !draft.clips.length} onClick={() => { if (window.confirm('清空当前时间线？只移除剪辑片段，所有原视频和抽帧图片保留。')) { setTimelinePreview(false); controller.updateDraft((current) => ({ ...current, clips: [] })); } }}>清空</button></div></div>
        <div className="vwb-edit-setup">
          <label className="vwb-label">剪辑方案名称<input value={draft.name} disabled={busy} maxLength={120} onChange={(event) => controller.updateDraft((current) => ({ ...current, name: event.target.value }))} /></label>
          <div className="vwb-sequence-load"><label className="vwb-label">长剧情分段<select value={planId} onChange={(event) => setPlanId(event.target.value)} disabled={busy}><option value="">选择长剧情方案</option>{project.sequencePlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.title} · {plan.segments.length} 段</option>)}</select></label><button type="button" className="btn small" disabled={busy || !available || !planId} title="按剧情顺序装载每段最新成片" onClick={() => { if (draft.clips.length && !window.confirm('按剧情顺序重新装载各段最新成片？这会替换当前剪辑片段，原视频不会修改。')) return; clipPages.setPage(0); void runAction(() => controller.loadSequence(planId)); }}><Layers size={12} />装载</button></div>
        </div>
        <div className="vwb-clips-browser">
          <ol ref={clipPages.listRef} className="vwb-clip-list" aria-label="剪辑片段">
            {clipPages.items.map((clip, pageIndex) => {
              const index = clipPages.page * clipPages.capacity + pageIndex;
              const asset = videos.find((item) => item.id === clip.sourceAssetId);
              const duration = controller.probes[clip.sourceAssetId]?.durationSec || asset?.durationSec;
              const invalid = !asset || asset.missing || clip.inSec < 0 || clip.outSec <= clip.inSec || Boolean(duration && clip.outSec > duration + .01);
              return <li key={clip.id} className={'vwb-clip' + (selectedClipId === clip.id ? ' selected' : '') + (dragOverClipId === clip.id ? ' drag-over' : '') + (invalid ? ' invalid' : '')} draggable={!busy}
                onDragStart={(event) => { if ((event.target as HTMLElement).closest('input,select,button')) { event.preventDefault(); return; } setDraggedClipId(clip.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-lianhua-clip', clip.id); }}
                onDragOver={(event) => { if (draggedClipId && !busy) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOverClipId(clip.id); } }}
                onDrop={(event) => { event.preventDefault(); if (draggedClipId && !busy) moveClip(draggedClipId, index); setDraggedClipId(''); setDragOverClipId(''); }}
                onDragEnd={() => { setDraggedClipId(''); setDragOverClipId(''); }}>
                <span className="vwb-grip" draggable={!busy} title={'拖动排序片段 ' + (index + 1)}><GripVertical size={14} /></span>
                <button type="button" className="vwb-clip-select" aria-pressed={selectedClipId === clip.id} title={asset?.name || '原视频已从资产库移除'} onClick={() => { if (asset) { chooseSource(asset, clip.id); const sourceIndex = filteredVideos.findIndex((item) => item.id === asset.id); if (sourceIndex >= 0) sourcePages.revealIndex(sourceIndex); } else setSelectedClipId(clip.id); }}><span className="vwb-clip-index">{index + 1}</span><strong>{asset?.name || '原视频已从资产库移除'}</strong>{invalid && <span className="vwb-invalid-mark">!</span>}</button>
                <span className="vwb-clip-summary">{formatTime(clip.outSec - clip.inSec)}</span>
                <div className="vwb-clip-controls"><button className="vwb-icon-button" type="button" title="上移" aria-label={'上移片段 ' + (index + 1)} disabled={busy || index === 0} onClick={() => { moveClip(clip.id, index - 1); clipPages.setPage(Math.floor((index - 1) / clipPages.capacity)); }}><ArrowUp size={12} /></button><button className="vwb-icon-button" type="button" title="下移" aria-label={'下移片段 ' + (index + 1)} disabled={busy || index === draft.clips.length - 1} onClick={() => { moveClip(clip.id, index + 1); clipPages.setPage(Math.floor((index + 1) / clipPages.capacity)); }}><ArrowDown size={12} /></button><button className="vwb-icon-button" type="button" title="移出时间线，保留原片" aria-label={'移除片段 ' + (index + 1)} disabled={busy} onClick={() => { setTimelinePreview(false); controller.updateDraft((current) => ({ ...current, clips: current.clips.filter((item) => item.id !== clip.id) })); }}><Trash2 size={12} /></button></div>
              </li>;
            })}
            {!draft.clips.length && <li className="vwb-empty"><Scissors size={25} /><span>用素材右侧「＋」加入视频，或按剧情装载。<br />拖动 / 上下移动可排序，原视频始终保留。</span></li>}
          </ol>
          <Pagination label="剪辑片段" total={draft.clips.length} page={clipPages.page} pageCount={clipPages.pageCount} onPage={clipPages.setPage} />
        </div>
        <section className="vwb-clip-editor" aria-label="选中片段设置">
          {selectedClip ? <>
            <div className="vwb-selected-heading"><strong title={selectedClipAsset?.name}>第 {selectedClipIndex + 1} 段 · {selectedClipAsset?.name || '缺失视频'}</strong><button type="button" className="vwb-help-button" onClick={() => clipPages.revealIndex(selectedClipIndex)}>定位片段</button></div>
            <div className="vwb-fields three">
              <label className="vwb-label">入点（秒）<input type="number" min="0" max={selectedClipDuration} step="0.01" value={selectedClip.inSec} disabled={busy} aria-label={'片段 ' + (selectedClipIndex + 1) + ' 入点'} onChange={(event) => changeClip(selectedClip.id, { inSec: Number(event.target.value) })} /></label>
              <label className="vwb-label">出点（秒）<input type="number" min="0" max={selectedClipDuration} step="0.01" value={selectedClip.outSec} disabled={busy} aria-label={'片段 ' + (selectedClipIndex + 1) + ' 出点'} onChange={(event) => changeClip(selectedClip.id, { outSec: Number(event.target.value) })} /></label>
              <label className="vwb-label">原声音量 %<input type="number" min="0" max="200" step="5" value={Math.round(selectedClip.volume * 100)} disabled={busy} aria-label={'片段 ' + (selectedClipIndex + 1) + ' 原声音量'} onChange={(event) => changeClip(selectedClip.id, { volume: Number(event.target.value) / 100 })} /></label>
            </div>
            <div className="vwb-playhead-actions"><button type="button" className="btn small ghost" aria-label="当前画面设为入点" disabled={busy || timelinePreview || selectedClip.sourceAssetId !== sourceId} onClick={() => changeClip(selectedClip.id, { inSec: Math.round(currentTime * 1000) / 1000 })}>当前处设入点</button><button type="button" className="btn small ghost" aria-label="当前画面设为出点" disabled={busy || timelinePreview || selectedClip.sourceAssetId !== sourceId} onClick={() => changeClip(selectedClip.id, { outSec: Math.round(currentTime * 1000) / 1000 })}>当前处设出点</button><button type="button" className="btn small ghost" disabled={busy || timelinePreview || selectedClip.sourceAssetId !== sourceId} onClick={() => splitClipAtPlayhead(selectedClip.id)}><Scissors size={12} />当前处分割</button></div>
            <div className="vwb-clip-transition">
              {selectedClipIndex < draft.clips.length - 1 ? <><span>到下一段</span><select aria-label={'片段 ' + (selectedClipIndex + 1) + ' 转场'} disabled={busy} value={selectedClip.transitionAfter.type} onChange={(event) => changeClip(selectedClip.id, { transitionAfter: { type: event.target.value as 'cut' | 'crossfade', durationSec: selectedClip.transitionAfter.durationSec || .4 } })}><option value="cut">硬切</option><option value="crossfade">交叉溶解</option></select>{selectedClip.transitionAfter.type === 'crossfade' && <label>时长 <input type="number" min="0.04" max="5" step="0.1" aria-label={'片段 ' + (selectedClipIndex + 1) + ' 转场秒数'} disabled={busy} value={selectedClip.transitionAfter.durationSec} onChange={(event) => changeClip(selectedClip.id, { transitionAfter: { ...selectedClip.transitionAfter, durationSec: Number(event.target.value) } })} /> 秒</label>}</> : <span>当前是最后一个片段</span>}
              <span className="vwb-clip-summary">片段 {formatTime(selectedClip.outSec - selectedClip.inSec)}</span>
            </div>
            {clipError && <button type="button" className="vwb-inline-error vwb-help-button" title={clipError} onClick={() => showMessage('片段需要修正', clipError)}>{clipError}</button>}
          </> : <div className="vwb-empty vwb-select-hint"><span>点击上方片段设置裁剪、音量和转场；输出与声音在下方直接调整。</span></div>}
        </section>
        <WorkbenchOutputSettings draft={draft} controller={controller} busy={busy} audioAssets={audioAssets} onOpenAssets={onOpenAssets}
          onHelp={() => showMessage('输出与声音说明', '导出新的 MP4 / H.264 / AAC 文件，原视频保持不变。音频统一为 48 kHz；画面等比缩放并按需加边，不拉伸。\nBGM 不足会循环播放；建议原声 100%、BGM 12%，启用“原声优先”可在对白等原声出现时自动压低背景音乐。画面和声音淡入淡出独立设置。')} />
      </section>}

      {activeTab === 'frames' && <section className="vwb-panel vwb-tab-pane vwb-frames-pane" id="vwb-pane-frames" role="tabpanel" aria-labelledby="vwb-tab-frames" tabIndex={0}>
        <div className="vwb-panel-heading"><h2><ImageIcon size={15} />抽帧与连续性</h2><button type="button" className="btn small ghost" onClick={() => onOpenAssets('image')}>图片资产库</button></div>
        <div className="vwb-frame-settings" aria-label="抽帧参数">
          <div className="vwb-fields">
            <label className="vwb-label">抽取方式<select value={frameMode} disabled={busy} onChange={(event) => setFrameMode(event.target.value as WorkbenchFrameMode)}><option value="first">首帧</option><option value="last">尾帧（最后有效画面）</option><option value="time">指定时间</option><option value="frame">指定帧号</option><option value="uniform">均匀抽取 N 帧</option><option value="boundaries">同时抽取首尾帧</option></select></label>
            {frameMode === 'time' ? <label className="vwb-label"><span className="vwb-label-action">原视频时间（秒）<button type="button" className="vwb-help-button" aria-label="使用当前画面时间" disabled={!source || busy || timelinePreview} onClick={() => setFrameTime(Math.round(currentTime * 1000) / 1000)}>当前画面</button></span><input type="number" min="0" max={sourceDuration} step="0.001" disabled={busy} value={frameTime} onChange={(event) => setFrameTime(Number(event.target.value))} /></label>
              : frameMode === 'frame' ? <label className="vwb-label" title="按真实解码帧序号提取，适用于可变帧率视频。">原视频第几帧（从 1 开始）<input type="number" min="1" max={probe?.frameCount} step="1" disabled={busy} value={frameNumber} onChange={(event) => setFrameNumber(Number(event.target.value))} /></label>
                : frameMode === 'uniform' ? <label className="vwb-label">抽取数量（2–60）<input type="number" min="2" max="60" step="1" disabled={busy} value={frameCount} onChange={(event) => setFrameCount(Number(event.target.value))} /></label>
                  : <div className="vwb-extract-source"><span>当前视频</span><strong title={source?.name}>{source?.name || '请先选择左侧视频'}</strong></div>}
          </div>
          <div className="vwb-range-row"><label className="vwb-check"><input type="checkbox" checked={useClipRange} disabled={busy || !selectedClip || selectedClip.sourceAssetId !== sourceId} onChange={(event) => setUseClipRange(event.target.checked)} />使用选中片段裁剪区间</label><span className={selectedRangeInvalid ? 'vwb-inline-error' : 'vwb-help'} title="时间和帧号仍按原视频定位。">{selectedRangeInvalid ? '区间无效，请先修正' : extractRange ? formatTime(extractRange.inSec) + ' → ' + formatTime(extractRange.outSec) : '完整原视频'}</span></div>
        </div>
        <div className="vwb-reference-settings">
          <label className="vwb-label">带入哪一段的视频生成<select value={targetStoryboardId} onChange={(event) => setTargetStoryboardId(event.target.value)}><option value="">只带入图片，保留导演台当前提示词</option>{selectedPlan?.segments.filter((segment) => segment.storyboardId).map((segment) => <option key={segment.storyboardId} value={segment.storyboardId}>第 {segment.index} 段 · {segment.title}</option>)}{project.storyboards.filter((board) => !selectedPlan?.segments.some((segment) => segment.storyboardId === board.id)).map((board) => <option key={board.id} value={board.id}>{board.sourceStoryTitle || project.scenes.find((scene) => scene.id === board.sceneId)?.title || '未命名分镜'} · {board.durationSec} 秒</option>)}</select></label>
          <div className="vwb-range-row"><label className="vwb-check" title="不勾选则作为构图参考"><input type="checkbox" checked={useAsFirstFrame} onChange={(event) => setUseAsFirstFrame(event.target.checked)} />作为下一段首帧参考</label>{nextSegment?.storyboardId && <button type="button" className="btn small" onClick={() => { setTargetStoryboardId(nextSegment.storyboardId || ''); setUseAsFirstFrame(true); }}>选择下一段：第 {nextSegment.index} 段</button>}<button type="button" className="vwb-help-button" onClick={() => showMessage('衔接参考帧说明', '上一段尾帧 → 作为下一段首帧参考 → 视频导演台确认后生成。\n只带入草稿，不会自动提交、覆盖原提示词或清空参考图；模型不支持首帧时请在视频导演台调整用途。\n抽帧图片保留来源视频、时间、帧号与校验信息。指定时间和帧号始终按原视频定位。')}>衔接说明</button></div>
        </div>
        <div className="vwb-frame-results" aria-label="衔接参考帧">
          <div className="vwb-panel-heading"><h3>衔接参考帧</h3><select aria-label="抽帧结果筛选" value={resultSourceFilter} onChange={(event) => { setResultSourceFilter(event.target.value as 'current' | 'all'); framePages.setPage(0); }}><option value="current">当前视频的抽帧</option><option value="all">项目全部抽帧</option></select></div>
          <div ref={framePages.listRef} className="vwb-frame-list">
            {framePages.items.map((asset) => {
              const parent = videos.find((video) => video.id === asset.sourceVideoAssetId);
              return <article className="vwb-frame-card" key={asset.id}>
                <button type="button" className="vwb-frame-preview-button" aria-label={'放大抽帧 ' + asset.name} onClick={() => setFramePreview(asset)}><span className="vwb-thumb">{assetPreviewUrl(asset) && !asset.missing ? <img src={assetPreviewUrl(asset)} alt={asset.name} loading="lazy" /> : <ImageIcon size={24} />}</span></button>
                <div className="vwb-frame-copy"><strong>{frameRoleLabel(asset)} · {formatTime(asset.sourceTimeSec)}</strong><small title={(parent?.name || '来源视频记录已移除') + (asset.sourceFrameIndex !== undefined ? ' · 第 ' + (asset.sourceFrameIndex + 1) + ' 帧' : '')}>{parent?.name || '来源视频记录已移除'}</small>{asset.sourceFrameIndex !== undefined && <small>第 {asset.sourceFrameIndex + 1} 帧</small>}</div>
                <button type="button" className="btn small vwb-frame-send" aria-label={'送到视频导演台 ' + asset.name} disabled={asset.missing || busy} onClick={() => sendFrame(asset)}><Link2 size={12} />送到视频导演台</button>
              </article>;
            })}
            {!filteredFrames.length && <div className="vwb-empty"><ImageIcon size={23} /><span>{frames.length && resultSourceFilter === 'current' ? '当前视频尚未抽帧，可切换“项目全部抽帧”。' : '点击底部抽帧按钮，提取画面作为下一段参考。'}</span></div>}
          </div>
          <Pagination label="衔接参考帧" total={filteredFrames.length} page={framePages.page} pageCount={framePages.pageCount} onPage={framePages.setPage} />
        </div>
      </section>}

      {activeTab === 'jobs' && <section className="vwb-panel vwb-tab-pane vwb-jobs-pane" id="vwb-pane-jobs" role="tabpanel" aria-labelledby="vwb-tab-jobs" tabIndex={0}>
        <div className="vwb-panel-heading"><h2><Film size={15} />工作台处理记录</h2><span className="vwb-count">结果、错误与重试</span></div>
        <div ref={jobPages.listRef} className="vwb-job-list">
          {jobPages.items.map((job) => {
            const resultVideo = project.assets.find((asset) => job.resultAssetIds.includes(asset.id) && isVideo(asset));
            const retryable = ['failed', 'cancelled', 'interrupted'].includes(job.status);
            const statusLabel = { running: '处理中', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '上次处理已中断' }[job.status];
            return <article className="vwb-job" key={job.id}>
              <div className="vwb-job-info"><strong title={job.name}>{job.name}</strong><small>{statusLabel} · {new Date(job.updatedAt).toLocaleString()} · {job.resultAssetIds.length} 项结果</small>{job.error && <button type="button" className="vwb-inline-error vwb-help-button" title={job.error} onClick={() => showMessage('处理错误：' + job.name, job.error || '')}>{job.error}</button>}</div>
              <div className="vwb-job-actions">
                {resultVideo && <button type="button" className="btn small" onClick={() => { chooseSource(resultVideo); setActiveTab('edit'); const index = filteredVideos.findIndex((asset) => asset.id === resultVideo.id); if (index >= 0) sourcePages.revealIndex(index); }}>预览成片</button>}
                {resultVideo?.relativePath && <button type="button" className="btn small" onClick={() => void runAction(async () => { await window.lianhuaDesktop?.revealAsset?.(resultVideo.relativePath!); })}>打开文件位置</button>}
                {job.status === 'succeeded' && !resultVideo && job.resultAssetIds.length > 0 && <button type="button" className="btn small" onClick={() => { setResultSourceFilter('all'); setActiveTab('frames'); const frameIndex = frames.findIndex((asset) => job.resultAssetIds.includes(asset.id)); framePages.revealIndex(Math.max(0, frameIndex)); }}>查看抽帧</button>}
                {retryable && <button type="button" className="btn small" disabled={busy || !available} onClick={() => void runAction(() => controller.retryJob(job.id))}>重新执行</button>}
                {job.error && <button type="button" className="btn small ghost" onClick={() => showMessage('处理错误：' + job.name, job.error || '')}>错误详情</button>}
              </div>
            </article>;
          })}
          {!controller.jobs.length && <div className="vwb-empty"><Film size={28} /><span>抽帧和导出后，处理进度、结果与重试会记录在这里。</span></div>}
        </div>
        <Pagination label="处理记录" total={controller.jobs.length} page={jobPages.page} pageCount={jobPages.pageCount} onPage={jobPages.setPage} />
      </section>}
    </div>

    <footer className="vwb-footer" aria-label="工作台操作与进度">
      <div className={'vwb-footer-notice' + (hasError ? ' error' : !available ? ' warning' : '')} role={hasError ? 'alert' : 'status'}>
        {hasError ? <X size={14} /> : <CheckCircle2 size={14} />}
        <span title={footerMessage}>{footerMessage}</span>
        <button type="button" className="vwb-help-button" onClick={() => showMessage(hasError ? '工作台错误详情' : !available ? '本地处理引擎状态' : '工作台提示', footerMessage)}>详情</button>
        {!available && <button type="button" className="btn small ghost" disabled={busy} onClick={() => void runAction(controller.refreshStatus)}><RefreshCw size={12} />重新检测</button>}
        {(localError || localNotice) && <button type="button" className="vwb-icon-button" aria-label={localError ? '关闭工作台错误' : '关闭工作台提示'} onClick={() => { setLocalError(''); setLocalNotice(''); }}><X size={12} /></button>}
      </div>
      <div className="vwb-footer-main">
        <div className="vwb-progress" aria-label="视频处理任务">
          <div className="vwb-progress-line"><strong>{addingSources ? '添加所选视频' : busy ? progress?.kind === 'extract' ? '抽取参考帧' : progress?.kind === 'render' ? '导出视频' : '准备素材' : progress?.stage === 'completed' ? '处理完成' : '等待操作'}</strong><span>{addingSources ? `${addingSources.completed}/${addingSources.total}` : busy || progress ? Math.round(progress?.percent || 0) + '%' : draft.clips.length + ' 段 · ' + formatTime(Math.max(0, totalDuration))}</span></div>
          <progress max="100" value={addingSources ? addingSources.completed / Math.max(1, addingSources.total) * 100 : progress?.percent || 0} aria-label="视频处理进度" />
        </div>
        <div className="vwb-footer-actions">
          {busy && <button type="button" className="btn small" onClick={() => { if (addingRun.current) addingRun.current.cancelled = true; void runAction(controller.cancel); }}>取消处理</button>}
          {activeTab === 'frames' && <><button type="button" className="btn small" aria-label="为全部片段提取首尾衔接帧" disabled={busy || !available || !draft.clips.length} onClick={() => { setResultSourceFilter('all'); framePages.setPage(0); void runAction(() => controller.extractBoundaries(draft)); }}><Link2 size={13} />批量首尾帧</button><button type="button" className="btn primary" aria-label="抽帧并保存到资产库" disabled={busy || !available || !source || source.missing || selectedRangeInvalid} onClick={() => { framePages.setPage(0); extract(); }}><ImageIcon size={13} />抽帧并保存</button></>}
          {activeTab !== 'frames' && <button type="button" className="btn primary" disabled={busy || !available || !draft.clips.length} onClick={() => { setTimelinePreview(false); videoRef.current?.pause(); void runAction(() => controller.renderTimeline()); }}><Film size={14} />导出成片</button>}
        </div>
      </div>
    </footer>

    {framePreview && <div className="vwb-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setFramePreview(undefined); }}><div ref={dialogRef} className="vwb-modal vwb-frame-modal" role="dialog" aria-modal="true" aria-label={'抽帧预览 ' + framePreview.name}><div className="vwb-row"><strong title={framePreview.name}>{framePreview.name}</strong><button ref={dialogCloseRef} type="button" className="btn small" onClick={() => setFramePreview(undefined)}>关闭</button></div><img src={assetPreviewUrl(framePreview)} alt={framePreview.name} /><p className="vwb-help">来源时间 {formatTime(framePreview.sourceTimeSec)} · {framePreview.width || '?'} × {framePreview.height || '?'}</p></div></div>}
    {messageDialog && <div className="vwb-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setMessageDialog(undefined); }}><div ref={dialogRef} className="vwb-modal vwb-message-modal" role="dialog" aria-modal="true" aria-label={messageDialog.title}><div className="vwb-row"><strong title={messageDialog.title}>{messageDialog.title}</strong><button ref={dialogCloseRef} type="button" className="btn small" onClick={() => setMessageDialog(undefined)}>关闭</button></div><div className="vwb-message-text">{detailPages[messagePage] || detailPages[0]}</div><Pagination label="消息详情" total={detailPages.length} page={Math.min(messagePage, detailPages.length - 1)} pageCount={detailPages.length} onPage={setMessagePage} /></div></div>}
  </div>;
}
