import type { AppState } from './types';
import {
  encodeStateSnapshot,
  type EncodedStateSnapshot,
  type StateSerializationPolicy,
  type StateSerializationReply,
  type StateSerializationRequest,
} from './stateSerialization';

export interface StateSerializationWorkerPort {
  postMessage: (request: StateSerializationRequest) => void;
  terminate: () => void;
  onmessage: ((event: { data: StateSerializationReply }) => void) | null;
  onerror: ((event: { message?: string; preventDefault?: () => void }) => void) | null;
  onmessageerror: (() => void) | null;
}

const createBrowserStateWorker = (): StateSerializationWorkerPort | undefined => (
  typeof Worker === 'function'
    ? new Worker(new URL('./stateSerialization.worker.ts', import.meta.url), { type: 'module', name: 'lianhua-state-encoder' }) as unknown as StateSerializationWorkerPort
    : undefined
);

/** postMessage runs before encode() returns: callers may freely change their
 * live state later without changing the queued snapshot. */
export const createStateSerializationClient = (
  createWorker: () => StateSerializationWorkerPort | undefined = createBrowserStateWorker,
) => {
  let worker: StateSerializationWorkerPort | undefined;
  let disabled = false;
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: EncodedStateSnapshot) => void; reject: (error: Error) => void }>();
  const failWorker = (message: string) => {
    disabled = true;
    worker?.terminate();
    worker = undefined;
    const error = new Error(message);
    for (const job of pending.values()) job.reject(error);
    pending.clear();
  };
  const obtainWorker = () => {
    if (worker || disabled) return worker;
    try {
      worker = createWorker();
      if (!worker) return undefined;
      worker.onmessage = ({ data }) => {
        const job = pending.get(data.id);
        if (!job) return;
        pending.delete(data.id);
        if (data.ok) job.resolve(data.result);
        else job.reject(new Error(data.error));
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        failWorker(`本地存档后台编码失败：${event.message || '编码线程无法启动或已停止'}；本次未写入，请重试保存。`);
      };
      worker.onmessageerror = () => failWorker('本地存档后台编码通信失败；本次未写入，请重试保存。');
      return worker;
    } catch {
      // Construction/security failures are still synchronous, so a fallback
      // can capture the original call's state without any mutable-data race.
      disabled = true;
      worker?.terminate();
      worker = undefined;
      return undefined;
    }
  };
  const encode = (state: AppState, policy: StateSerializationPolicy): Promise<EncodedStateSnapshot> => {
    const target = obtainWorker();
    if (!target) {
      try { return Promise.resolve(encodeStateSnapshot(state, policy, true)); }
      catch (error) { return Promise.reject(error); }
    }
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        target.postMessage({ id, state, policy });
      } catch (error) {
        pending.delete(id);
        // A failed post has sent no snapshot and written nothing. Do not
        // retry a possibly different state after an asynchronous error.
        reject(error instanceof Error ? error : new Error('本地存档快照无法发送到编码线程'));
      }
    });
  };
  return { encode, dispose: () => failWorker('本地存档编码线程已关闭；本次未写入。') };
};

/** Serialization may finish out of order, but persistence/mirroring never
 * does. Rejections are observed immediately and always release the next save. */
export const createOrderedStateSaveQueue = () => {
  let tail: Promise<void> = Promise.resolve();
  return <T>(encoding: Promise<EncodedStateSnapshot>, write: (encoded: EncodedStateSnapshot) => Promise<T>): Promise<T> => {
    const captured = encoding.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const result = tail.then(async () => {
      const encoded = await captured;
      if (!encoded.ok) throw encoded.error;
      return write(encoded.value);
    });
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
};
