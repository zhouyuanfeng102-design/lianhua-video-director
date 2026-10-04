import type { ManagedMediaResult } from './storage';

/** Only managed asset paths are accepted by the desktop media processor. */
export interface WorkbenchMediaSource {
  assetId: string;
  relativePath: string;
  expectedChecksum?: string;
}

export interface WorkbenchVideoProbe {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  frameCount?: number;
  hasAudio: boolean;
  videoCodec: string;
  audioCodec?: string;
  audioSampleRate?: number;
  audioChannels?: number;
  variableFrameRate?: boolean;
}

export interface VideoWorkbenchStatus {
  available: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
  source?: 'bundled' | 'system' | 'configured';
  message: string;
}

export type WorkbenchFrameMode = 'first' | 'last' | 'time' | 'frame' | 'uniform' | 'boundaries';

export interface WorkbenchFrameRequest {
  jobId: string;
  projectId: string;
  source: WorkbenchMediaSource;
  mode: WorkbenchFrameMode;
  timeSec?: number;
  /** Zero-based decoded frame index; unlike time*fps, this supports VFR input. */
  frameIndex?: number;
  count?: number;
  /** Optional non-destructive trim range, in source-video seconds. */
  inSec?: number;
  outSec?: number;
  fileName?: string;
}

export interface WorkbenchExtractedFrame extends ManagedMediaResult {
  timeSec: number;
  frameIndex?: number;
  width: number;
  height: number;
  role: 'first-frame' | 'last-frame' | 'custom-frame';
}

export interface WorkbenchFrameResult {
  probe: WorkbenchVideoProbe;
  frames: WorkbenchExtractedFrame[];
}

export interface WorkbenchRenderClip {
  source: WorkbenchMediaSource;
  inSec: number;
  outSec: number;
  /** Linear gain; 0 means muted, 1 means original loudness. */
  volume?: number;
  transitionAfter?: {
    type: 'cut' | 'crossfade';
    durationSec: number;
  };
}

export interface WorkbenchRenderRequest {
  jobId: string;
  projectId: string;
  clips: WorkbenchRenderClip[];
  output?: {
    width?: number;
    height?: number;
    fps?: number;
    fileName?: string;
    fadeInSec?: number;
    fadeOutSec?: number;
  };
  audio?: {
    bgm?: WorkbenchMediaSource;
    /** Linear gain, default 0.16; deliberately bounded to preserve dialogue. */
    bgmVolume?: number;
    ducking?: boolean;
    fadeInSec?: number;
    fadeOutSec?: number;
  };
}

export interface WorkbenchRenderResult extends ManagedMediaResult {
  probe: WorkbenchVideoProbe;
  renderMode: 'transcode';
}

export interface WorkbenchProgress {
  jobId: string;
  projectId: string;
  kind: 'extract' | 'render';
  stage: 'preparing' | 'processing' | 'saving' | 'completed' | 'cancelled' | 'failed';
  /** 0–100 inclusive. */
  percent: number;
  message: string;
}
