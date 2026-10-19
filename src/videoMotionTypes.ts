/** A selected clip occupies its own video slot, independent of image/audio slots. */
export interface VideoMotionReference {
  assetId: string;
  slotIndex: number;
  bindingId: string;
  notes?: string;
}

export interface FrozenVideoMotionReference extends VideoMotionReference {
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
