export type AudioRetainMode = 'reference' | 'fully_copy' | 'partially_copy' | 'weak_reference';

export type VideoAudioTarget =
  | { kind: 'character'; characterId: string }
  | { kind: 'voiceover' }
  | { kind: 'ambience' };

/** Audio positions are independent of picture positions and never compacted. */
export interface VideoAudioReference {
  bindingId: string;
  assetId: string;
  slotIndex: number;
  target: VideoAudioTarget;
  retainMode: AudioRetainMode;
  notes?: string;
}

export interface VideoVoicePreset {
  assetId: string;
  retainMode?: AudioRetainMode;
  notes?: string;
}

export interface ProjectVoicePresets {
  characters: Record<string, VideoVoicePreset>;
  narrator?: VideoVoicePreset;
}

export interface FrozenVideoAudioReference extends VideoAudioReference {
  /** Display label captured at submission; later project edits cannot rename it. */
  targetLabel?: string;
  name: string;
  fileName?: string;
  relativePath?: string;
  checksum?: string;
  url?: string;
  dataUrl?: string;
  mimeType?: string;
  durationSec?: number;
  freezeState?: 'pending' | 'frozen';
  frozenAt?: number;
}

export interface VideoAudioSelectionOverride {
  mode: 'project' | 'override' | 'none';
  references?: VideoAudioReference[];
}
