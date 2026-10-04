import type { ReferenceAsset } from './types';
import type { ManagedMediaResult } from './storage';

export interface MediaProbe {
  durationSec?: number;
  width?: number;
  height?: number;
  sampleRate?: number;
  channelCount?: number;
  waveform?: number[];
  firstFrameDataUrl?: string;
  lastFrameDataUrl?: string;
}

const ascii = (view: DataView, offset: number, length: number): string => (
  Array.from({ length }, (_, index) => String.fromCharCode(view.getUint8(offset + index))).join('')
);

const probeWavHeader = (buffer: ArrayBuffer): Pick<MediaProbe, 'durationSec' | 'sampleRate' | 'channelCount'> => {
  if (buffer.byteLength < 44) return {};
  const view = new DataView(buffer);
  if (ascii(view, 0, 4) !== 'RIFF' || ascii(view, 8, 4) !== 'WAVE') return {};
  let offset = 12;
  let sampleRate = 0;
  let channelCount = 0;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= view.byteLength) {
    const id = ascii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + size > view.byteLength) break;
    if (id === 'fmt ' && size >= 16) {
      channelCount = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true);
      byteRate = view.getUint32(start + 8, true);
    } else if (id === 'data') {
      dataBytes = size;
    }
    offset = start + size + (size % 2);
  }
  return {
    ...(sampleRate ? { sampleRate } : {}),
    ...(channelCount ? { channelCount } : {}),
    ...(byteRate && dataBytes ? { durationSec: Math.round((dataBytes / byteRate) * 100) / 100 } : {}),
  };
};

const VIDEO_EVENT_TIMEOUT_MS = 10_000;

const waitForVideoEvents = (
  video: HTMLVideoElement,
  successEvents: Array<'loadedmetadata' | 'durationchange' | 'seeked'>,
  errorMessage: string,
  timeoutMessage: string,
  start?: () => void,
): Promise<void> => new Promise((resolve, reject) => {
  let settled = false;
  let timer: number | undefined;
  const cleanup = () => {
    successEvents.forEach((eventName) => video.removeEventListener(eventName, finish));
    video.removeEventListener('error', fail);
    if (timer !== undefined) window.clearTimeout(timer);
  };
  const settle = (error?: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) reject(error);
    else resolve();
  };
  const finish = () => settle();
  const fail = () => settle(new Error(errorMessage));
  successEvents.forEach((eventName) => video.addEventListener(eventName, finish, { once: true }));
  video.addEventListener('error', fail, { once: true });
  timer = window.setTimeout(() => settle(new Error(timeoutMessage)), VIDEO_EVENT_TIMEOUT_MS);
  try {
    start?.();
  } catch (error) {
    settle(error instanceof Error ? error : new Error(errorMessage));
  }
});

const seekVideo = (video: HTMLVideoElement, time: number): Promise<void> => {
  if (!Number.isFinite(video.duration)) return Promise.reject(new Error('无法读取有效视频时长'));
  const target = Math.max(0, Math.min(time, Math.max(0, video.duration - 0.04)));
  return waitForVideoEvents(
    video,
    ['seeked'],
    '无法定位视频帧',
    '定位视频帧超时',
    () => { video.currentTime = target; },
  );
};

const frameFromVideo = (video: HTMLVideoElement): string => {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight, 1));
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法创建视频帧画布');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.86);
};

export const probeVideoFile = async (file: File): Promise<MediaProbe> => {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  try {
    await waitForVideoEvents(
      video,
      ['loadedmetadata'],
      '无法读取视频元数据',
      '读取视频元数据超时',
      () => { video.src = url; },
    );
    // MediaRecorder WebM files may omit duration metadata. Seeking far past
    // the end makes Chromium index the clusters and expose the real duration.
    if (!Number.isFinite(video.duration)) {
      await waitForVideoEvents(
        video,
        ['durationchange', 'seeked'],
        '无法建立视频时长索引',
        '建立视频时长索引超时',
        () => { video.currentTime = 1e10; },
      );
    }
    if (!Number.isFinite(video.duration)) throw new Error('无法读取有效视频时长');
    await seekVideo(video, 0);
    const firstFrameDataUrl = frameFromVideo(video);
    await seekVideo(video, Math.max(0, video.duration - 0.08));
    const lastFrameDataUrl = frameFromVideo(video);
    return {
      durationSec: Number.isFinite(video.duration) ? Math.round(video.duration * 100) / 100 : undefined,
      width: video.videoWidth || undefined,
      height: video.videoHeight || undefined,
      firstFrameDataUrl,
      lastFrameDataUrl,
    };
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute('src');
    video.load();
  }
};

export const probeAudioFile = async (file: File): Promise<MediaProbe> => {
  const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) throw new Error('当前环境不支持音频分析');
  const context = new AudioContextCtor();
  try {
    const source = await file.arrayBuffer();
    const container = probeWavHeader(source);
    const buffer = await context.decodeAudioData(source.slice(0));
    const buckets = 96;
    const samples = buffer.getChannelData(0);
    const bucketSize = Math.max(1, Math.floor(samples.length / buckets));
    const waveform = Array.from({ length: buckets }, (_, index) => {
      let peak = 0;
      const end = Math.min(samples.length, (index + 1) * bucketSize);
      for (let cursor = index * bucketSize; cursor < end; cursor += 1) peak = Math.max(peak, Math.abs(samples[cursor]));
      return Math.round(peak * 1000) / 1000;
    });
    return {
      durationSec: container.durationSec ?? Math.round(buffer.duration * 100) / 100,
      sampleRate: container.sampleRate ?? buffer.sampleRate,
      channelCount: container.channelCount ?? buffer.numberOfChannels,
      waveform,
    };
  } finally {
    void context.close();
  }
};

export const createFrameAsset = (
  dataUrl: string,
  parent: ManagedMediaResult,
  role: 'first-frame' | 'last-frame',
  createId: (prefix: string) => string,
): ReferenceAsset => ({
  id: createId('asset'),
  name: `${parent.fileName} · ${role === 'first-frame' ? '首帧' : '尾帧'}`,
  type: role,
  role,
  dataUrl,
  mediaType: 'image',
  referenceRole: role,
  source: 'derived',
  tags: ['视频抽帧', role],
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

export const assetPreviewUrl = (asset: ReferenceAsset): string => asset.dataUrl || asset.url || '';
