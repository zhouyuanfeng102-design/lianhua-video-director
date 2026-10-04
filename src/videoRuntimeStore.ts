import { useCallback, useSyncExternalStore } from 'react';
import type { VideoGenerationRuntime } from './videoGenerationTypes';

export const VIDEO_RUNTIME_FIELDS = [
  'stage', 'message', 'progress', 'nodeId', 'step', 'totalSteps',
  'startedAt', 'submittedAt', 'generatedAt', 'completedAt',
  'trackingStopped', 'cancellationPending', 'cancellationConfirmed',
  'downloadError', 'receivedBytes', 'totalBytes',
] as const satisfies readonly (keyof VideoGenerationRuntime)[];

export type VideoRuntimeSnapshot = Readonly<Record<string, VideoGenerationRuntime>>;
const EMPTY_RUNTIME_SNAPSHOT: VideoRuntimeSnapshot = Object.freeze(Object.create(null) as Record<string, VideoGenerationRuntime>);
const noSubscription = () => () => {};

/** Engine callbacks may carry an entire job via object spread. Never retain
 * its frozen prompts, image data, connection or other project-sized objects. */
export const pickVideoRuntime = (runtime: VideoGenerationRuntime): VideoGenerationRuntime => {
  const picked = {} as VideoGenerationRuntime;
  for (const key of VIDEO_RUNTIME_FIELDS) {
    // Preserve explicit undefined (clearing an old error) without inventing
    // undefined keys that would hide fields in a persisted partial runtime.
    if (Object.prototype.hasOwnProperty.call(runtime, key)) (picked as unknown as Record<string, unknown>)[key] = runtime[key];
  }
  return Object.freeze(picked);
};

export const videoRuntimeEqual = (left: VideoGenerationRuntime | undefined, right: VideoGenerationRuntime | undefined): boolean => (
  left === right || Boolean(left && right && VIDEO_RUNTIME_FIELDS.every((key) => (
    Object.prototype.hasOwnProperty.call(left, key) === Object.prototype.hasOwnProperty.call(right, key)
      && Object.is(left[key], right[key])
  )))
);

export interface VideoRuntimeStore {
  getSnapshot: () => VideoRuntimeSnapshot;
  getTaskSnapshot: (taskId: string) => VideoGenerationRuntime | undefined;
  subscribe: (listener: () => void) => () => void;
  subscribeTask: (taskId: string, listener: () => void) => () => void;
  update: (taskId: string, runtime: VideoGenerationRuntime) => void;
  remove: (taskId: string) => void;
  /** Reset engine-owned data/timers while preserving React's subscriptions
   * across a ready-state change or StrictMode effect cleanup/setup replay. */
  clear: () => void;
  dispose: () => void;
}

interface VideoRuntimeStoreOptions {
  throttleMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
}

const urgentRuntimeChange = (previous: VideoGenerationRuntime | undefined, next: VideoGenerationRuntime): boolean => (
  !previous || previous.stage !== next.stage
    || ['succeeded', 'failed', 'stopped', 'submission-unknown'].includes(next.stage)
    || (['trackingStopped', 'cancellationPending', 'cancellationConfirmed', 'downloadError', 'generatedAt', 'completedAt'] as const)
      .some((key) => !Object.is(previous[key], next[key]))
);

/** Only presentation notifications are coalesced. update() accepts the latest
 * progress synchronously; it never schedules engine actions, persistence or
 * provider requests. Each task has an independent subscription boundary. */
export function createVideoRuntimeStore(options: VideoRuntimeStoreOptions = {}): VideoRuntimeStore {
  const throttleMs = Math.max(100, Math.min(250, options.throttleMs ?? 200));
  const schedule = options.schedule || ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancelScheduled = options.cancelScheduled || ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let snapshot: VideoRuntimeSnapshot = EMPTY_RUNTIME_SNAPSHOT;
  const pending = new Map<string, VideoGenerationRuntime>();
  const listeners = new Set<() => void>();
  const taskListeners = new Map<string, Set<() => void>>();
  let timer: unknown;
  let timerScheduled = false;
  let disposed = false;

  const stopTimer = () => {
    if (timerScheduled) cancelScheduled(timer);
    timer = undefined;
    timerScheduled = false;
  };
  const notify = (changedIds: readonly string[]) => {
    // A failed view subscriber must never interrupt generation/cancellation.
    const safelyNotify = (listener: () => void) => { try { listener(); } catch { /* isolated presentation subscriber */ } };
    for (const taskId of changedIds) [...(taskListeners.get(taskId) || [])].forEach(safelyNotify);
    [...listeners].forEach(safelyNotify);
  };
  const publish = (ids: readonly string[]) => {
    const changed: string[] = [];
    const next: Record<string, VideoGenerationRuntime> = Object.assign(Object.create(null), snapshot);
    for (const taskId of ids) {
      const runtime = pending.get(taskId);
      if (!runtime) continue;
      pending.delete(taskId);
      if (videoRuntimeEqual(snapshot[taskId], runtime)) continue;
      next[taskId] = runtime;
      changed.push(taskId);
    }
    if (!pending.size) stopTimer();
    if (!changed.length) return;
    snapshot = Object.freeze(next);
    notify(changed);
  };
  const clear = () => {
    stopTimer();
    pending.clear();
    const changed = Object.keys(snapshot);
    snapshot = EMPTY_RUNTIME_SNAPSHOT;
    if (changed.length) notify(changed);
  };

  return {
    getSnapshot: () => snapshot,
    getTaskSnapshot: (taskId) => snapshot[taskId],
    subscribe: (listener) => {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    subscribeTask: (taskId, listener) => {
      if (disposed) return () => {};
      let group = taskListeners.get(taskId);
      if (!group) { group = new Set(); taskListeners.set(taskId, group); }
      group.add(listener);
      return () => {
        group.delete(listener);
        if (!group.size && taskListeners.get(taskId) === group) taskListeners.delete(taskId);
      };
    },
    update: (taskId, runtime) => {
      if (disposed) return;
      const next = pickVideoRuntime(runtime);
      const previous = pending.get(taskId) || snapshot[taskId];
      if (videoRuntimeEqual(previous, next)) return;
      pending.set(taskId, next);
      if (urgentRuntimeChange(previous, next)) { publish([taskId]); return; }
      // A burst may return to the already visible value before it is flushed.
      if (videoRuntimeEqual(snapshot[taskId], next)) {
        pending.delete(taskId);
        if (!pending.size) stopTimer();
        return;
      }
      if (!timerScheduled) {
        timerScheduled = true;
        timer = schedule(() => {
          timerScheduled = false;
          timer = undefined;
          if (!disposed) publish([...pending.keys()]);
        }, throttleMs);
      }
    },
    remove: (taskId) => {
      pending.delete(taskId);
      if (!pending.size) stopTimer();
      if (!Object.prototype.hasOwnProperty.call(snapshot, taskId)) return;
      const next: Record<string, VideoGenerationRuntime> = Object.assign(Object.create(null), snapshot);
      delete next[taskId];
      snapshot = Object.keys(next).length ? Object.freeze(next) : EMPTY_RUNTIME_SNAPSHOT;
      notify([taskId]);
    },
    clear,
    dispose: () => {
      disposed = true;
      stopTimer(); pending.clear();
      snapshot = EMPTY_RUNTIME_SNAPSHOT;
      listeners.clear(); taskListeners.clear();
    },
  };
}

export function useVideoTaskRuntime(taskId: string, store?: VideoRuntimeStore, fallback?: VideoGenerationRuntime): VideoGenerationRuntime | undefined {
  const subscribe = useCallback((listener: () => void) => store ? store.subscribeTask(taskId, listener) : noSubscription(), [store, taskId]);
  const getSnapshot = useCallback(() => store ? store.getTaskSnapshot(taskId) : fallback, [store, taskId, fallback]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Use in the generation-task view, never in the application root. */
export function useVideoRuntimes(store?: VideoRuntimeStore, fallback: VideoRuntimeSnapshot = EMPTY_RUNTIME_SNAPSHOT): VideoRuntimeSnapshot {
  const getSnapshot = useCallback(() => store?.getSnapshot() ?? fallback, [store, fallback]);
  return useSyncExternalStore(store?.subscribe || noSubscription, getSnapshot, getSnapshot);
}
