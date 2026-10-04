import { useEffect, useRef } from 'react';
import type { AppState } from './types';
import type { VideoGenerationController } from './videoGenerationTypes';
import { VideoGenerationEngine } from './videoGeneration';
import { preflightVideoBatchManagedReferences } from './videoBatch';
import { saveStateAsync } from './storage';
import { createVideoRuntimeStore, type VideoRuntimeStore } from './videoRuntimeStore';

export const useVideoGenerationController = ({ state, setState, getCurrentState, ready = true, notify }: {
  state: AppState;
  setState: (updater: (current: AppState) => AppState) => void;
  getCurrentProjectId?: () => string;
  getCurrentState?: () => AppState;
  /** Automatic preparation may POST, so wait for the authoritative desktop state load. */
  ready?: boolean;
  notify?: (message: string, kind?: 'normal' | 'error') => void;
}): VideoGenerationController => {
  const current = useRef({ state, setState, getCurrentState, ready, notify });
  current.current = { state, setState, getCurrentState, ready, notify };
  const storeRef = useRef<VideoRuntimeStore | null>(null);
  if (!storeRef.current) storeRef.current = createVideoRuntimeStore();
  const runtimeStore = storeRef.current;
  const engine = useRef<VideoGenerationEngine | null>(null);
  const controller = useRef<VideoGenerationController | null>(null);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    const runtime = new VideoGenerationEngine({
      getState: () => current.current.getCurrentState?.() || current.current.state,
      setState: (updater) => current.current.setState(updater),
      persistState: async () => {
        // Runtime checkpoints and React autosave must share the same large
        // state encoder. Await the durable result before any submission.
        const saved = await saveStateAsync(current.current.getCurrentState?.() || current.current.state, { coalesce: 'checkpoint' });
        if (!saved.ok) throw new Error('视频任务记录保存失败，尚未提交生成。');
      },
      desktop: window.lianhuaDesktop,
      selectTailFrame: async (input) => {
        const config = { ...(current.current.getCurrentState?.() || current.current.state).settings.visionApi };
        const { extractVideoTailFrameSelection } = await import('./videoFrameSelection');
        return extractVideoTailFrameSelection({ ...input, config });
      },
      onRuntime: (taskId, progress) => { if (active) runtimeStore.update(taskId, progress); },
      onRemoveRuntime: (taskId) => { if (active) runtimeStore.remove(taskId); },
      notify: (message, kind) => current.current.notify?.(message, kind),
    });
    engine.current = runtime;
    runtime.reconcile();
    return () => {
      active = false;
      runtime.dispose();
      if (engine.current === runtime) engine.current = null;
      // Preserve subscriptions during StrictMode's cleanup/setup replay;
      // mounted card hooks unsubscribe themselves on the real unmount.
      runtimeStore.clear();
    };
  }, [ready, runtimeStore]);
  useEffect(() => { if (ready) engine.current?.reconcile(); }, [ready, state.project, state.projects,
    state.settings.videoExecutionMode, state.settings.videoExecutionConcurrency]);
  const get = () => {
    if (!current.current.ready) throw new Error('正式项目数据尚未加载完成，视频任务尚未启动。');
    if (!engine.current) throw new Error('视频任务控制器正在启动。');
    return engine.current;
  };
  if (!controller.current) controller.current = {
    start: (draft) => get().start(draft),
    startBatch: async (input) => {
      const runtime = get();
      await preflightVideoBatchManagedReferences(
        current.current.getCurrentState?.() || current.current.state,
        input,
        window.lianhuaDesktop,
      );
      return runtime.startBatch(input);
    },
    retryDownload: (taskId) => get().retryDownload(taskId),
    recoverResult: (taskId) => get().recoverResult(taskId),
    selectResultVideo: (taskId, assetId) => get().selectResultVideo(taskId, assetId),
    resume: (taskId) => get().resume(taskId),
    cancel: (taskId) => get().cancel(taskId),
    cancelBatch: (batchId) => get().cancelBatch(batchId),
    resumeBatch: (batchId) => get().resumeBatch(batchId),
    confirmContinueBatch: (planId, signal) => get().confirmContinueBatch(planId, signal),
    runtimeStore,
    get runtimeById() { return runtimeStore.getSnapshot(); },
  };
  return controller.current;
};
