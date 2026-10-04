import assert from 'node:assert/strict';
import { probeVideoFile } from '../src/media';

type VideoEventName = 'loadedmetadata' | 'durationchange' | 'seeked' | 'error';
type Listener = { callback: EventListener; once: boolean };

class FakeVideo {
  duration = 10;
  videoWidth = 640;
  videoHeight = 360;
  preload = '';
  muted = false;
  src = '';
  loadCalls = 0;
  currentTimeAssignments: number[] = [];
  emitMetadata = false;
  onCurrentTime?: (value: number, video: FakeVideo) => void;
  private currentTimeValue = 0;
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, callback: EventListener, options?: AddEventListenerOptions | boolean): void {
    const once = typeof options === 'object' && Boolean(options.once);
    this.listeners.set(type, [...(this.listeners.get(type) || []), { callback, once }]);
    if (type === 'loadedmetadata' && this.emitMetadata) queueMicrotask(() => this.emit('loadedmetadata'));
  }

  removeEventListener(type: string, callback: EventListener): void {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item.callback !== callback));
  }

  emit(type: VideoEventName): void {
    const listeners = [...(this.listeners.get(type) || [])];
    listeners.forEach((item) => {
      item.callback.call(this, new Event(type));
      if (item.once) this.removeEventListener(type, item.callback);
    });
  }

  listenerCount(): number {
    return Array.from(this.listeners.values()).reduce((count, listeners) => count + listeners.length, 0);
  }

  get currentTime(): number {
    return this.currentTimeValue;
  }

  set currentTime(value: number) {
    this.currentTimeValue = value;
    this.currentTimeAssignments.push(value);
    this.onCurrentTime?.(value, this);
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }

  load(): void {
    this.loadCalls += 1;
  }
}

let activeVideo = new FakeVideo();
let nextUrl = 0;
const revokedUrls: string[] = [];
const cancelledTimers = new Set<number>();
let nextTimer = 0;

(globalThis as any).window = {
  setTimeout: (callback: () => void) => {
    const id = ++nextTimer;
    queueMicrotask(() => { if (!cancelledTimers.has(id)) callback(); });
    return id;
  },
  clearTimeout: (id: number) => { cancelledTimers.add(id); },
};
(globalThis as any).document = {
  createElement: (tagName: string) => {
    if (tagName === 'video') return activeVideo;
    if (tagName === 'canvas') {
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => undefined }),
        toDataURL: () => 'data:image/jpeg;base64,frame',
      };
    }
    throw new Error(`unexpected element: ${tagName}`);
  },
};
(globalThis as any).URL = {
  createObjectURL: () => `blob:media-${++nextUrl}`,
  revokeObjectURL: (url: string) => { revokedUrls.push(url); },
};

type ProbeOutcome =
  | { kind: 'resolved' }
  | { kind: 'rejected'; error: Error }
  | { kind: 'hung' };

const settleProbe = async (video: FakeVideo): Promise<ProbeOutcome> => {
  activeVideo = video;
  const probe = probeVideoFile({} as File).then<ProbeOutcome, ProbeOutcome>(
    () => ({ kind: 'resolved' }),
    (error: unknown) => ({ kind: 'rejected', error: error instanceof Error ? error : new Error(String(error)) }),
  );
  return Promise.race([
    probe,
    new Promise<ProbeOutcome>((resolve) => globalThis.setTimeout(() => resolve({ kind: 'hung' }), 80)),
  ]);
};

const assertRejected = (outcome: ProbeOutcome, message: RegExp): void => {
  assert.notEqual(outcome.kind, 'hung', 'probeVideoFile must settle within a finite timeout');
  assert.equal(outcome.kind, 'rejected');
  if (outcome.kind === 'rejected') assert.match(outcome.error.message, message);
};

const metadataTimeoutVideo = new FakeVideo();
const metadataOutcome = await settleProbe(metadataTimeoutVideo);
assertRejected(metadataOutcome, /元数据.*超时/u);
assert.equal(metadataTimeoutVideo.listenerCount(), 0);
assert.equal(metadataTimeoutVideo.loadCalls, 1);
assert.equal(revokedUrls.length, 1);

const durationTimeoutVideo = new FakeVideo();
durationTimeoutVideo.duration = Number.POSITIVE_INFINITY;
durationTimeoutVideo.emitMetadata = true;
const durationOutcome = await settleProbe(durationTimeoutVideo);
assertRejected(durationOutcome, /时长.*超时/u);
assert.equal(durationTimeoutVideo.listenerCount(), 0);
assert.equal(durationTimeoutVideo.loadCalls, 1);
assert.equal(revokedUrls.length, 2);

const seekTimeoutVideo = new FakeVideo();
seekTimeoutVideo.emitMetadata = true;
const seekOutcome = await settleProbe(seekTimeoutVideo);
assertRejected(seekOutcome, /定位视频帧.*超时/u);
assert.equal(seekTimeoutVideo.listenerCount(), 0);
assert.equal(seekTimeoutVideo.loadCalls, 1);
assert.equal(revokedUrls.length, 3);

const invalidDurationVideo = new FakeVideo();
invalidDurationVideo.duration = Number.POSITIVE_INFINITY;
invalidDurationVideo.emitMetadata = true;
invalidDurationVideo.onCurrentTime = (value, video) => {
  if (value === 1e10) video.emit('durationchange');
  else video.emit('seeked');
};
const invalidDurationOutcome = await settleProbe(invalidDurationVideo);
assertRejected(invalidDurationOutcome, /有效视频时长/u);
assert.deepEqual(invalidDurationVideo.currentTimeAssignments, [1e10]);
assert.equal(invalidDurationVideo.listenerCount(), 0);
assert.equal(invalidDurationVideo.loadCalls, 1);
assert.equal(revokedUrls.length, 4);

console.log('video probe timeout, cleanup, and duration validation tests passed');
