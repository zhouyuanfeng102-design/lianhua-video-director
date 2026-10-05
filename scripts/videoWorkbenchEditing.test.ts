import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteWorkbenchClipRange, insertWorkbenchClip, replaceWorkbenchClipRange, trimWorkbenchClipRange,
  type VideoWorkbenchClip, type VideoWorkbenchDraft } from '../src/videoWorkbench';

const clip = (id: string, inSec = 0, outSec = 10, transitionAfter: VideoWorkbenchClip['transitionAfter'] = { type: 'cut', durationSec: 0.3 }): VideoWorkbenchClip => ({
  id, sourceAssetId: id, inSec, outSec, volume: 1, transitionAfter,
});
const draft = (...clips: VideoWorkbenchClip[]): VideoWorkbenchDraft => ({
  id: 'draft', name: 'test', clips, output: { width: 1920, height: 1080, fps: 30, fileName: 'test', fadeInSec: 0, fadeOutSec: 0 },
  audio: { bgmVolume: 0.12, ducking: true, fadeInSec: 0, fadeOutSec: 0 }, createdAt: 1, updatedAt: 1,
});

test('deleting an interior source range keeps both sides and hard-cuts the new seam', () => {
  const source = draft(clip('a', 0, 10, { type: 'crossfade', durationSec: 4 }), clip('b', 0, 8));
  const edited = deleteWorkbenchClipRange(source, 'a', { startSec: 3, endSec: 6 });
  assert.deepEqual(edited.clips.map((item) => [item.id, item.inSec, item.outSec]), [['a', 0, 3], ['a-tail', 6, 10], ['b', 0, 8]]);
  assert.deepEqual(edited.clips[0].transitionAfter, { type: 'cut', durationSec: 0 });
  assert.deepEqual(edited.clips[1].transitionAfter, { type: 'crossfade', durationSec: 2 });
  assert.deepEqual(source.clips.map((item) => [item.id, item.inSec, item.outSec]), [['a', 0, 10], ['b', 0, 8]]);
});

test('deleting a whole clip joins neighbors with a cut and preserves the source draft', () => {
  const source = draft(clip('a', 0, 4, { type: 'crossfade', durationSec: 1 }), clip('b', 2, 6), clip('c', 0, 4));
  const edited = deleteWorkbenchClipRange(source, 'b', { startSec: 2, endSec: 6 });
  assert.deepEqual(edited.clips.map((item) => item.id), ['a', 'c']);
  assert.deepEqual(edited.clips[0].transitionAfter, { type: 'cut', durationSec: 0 });
  assert.deepEqual(source.clips.map((item) => item.id), ['a', 'b', 'c']);
});

test('insertion at a source position splits the target and cuts both new seams', () => {
  const source = draft(clip('a', 0, 10, { type: 'crossfade', durationSec: 2 }), clip('b', 0, 4));
  const edited = insertWorkbenchClip(source, clip('inserted', 0, 2), { clipId: 'a', offsetSec: 4 });
  assert.deepEqual(edited.clips.map((item) => [item.id, item.inSec, item.outSec]), [['a', 0, 4], ['inserted', 0, 2], ['a-tail', 4, 10], ['b', 0, 4]]);
  assert.deepEqual(edited.clips[0].transitionAfter, { type: 'cut', durationSec: 0 });
  assert.deepEqual(edited.clips[1].transitionAfter, { type: 'cut', durationSec: 0 });
  assert.deepEqual(edited.clips[2].transitionAfter, { type: 'crossfade', durationSec: 2 });
});

test('split insertion allocates unique ids when the requested id matches the generated tail id', () => {
  const edited = insertWorkbenchClip(draft(clip('a', 0, 10)), clip('a-tail', 0, 1), { clipId: 'a', offsetSec: 5 });
  assert.equal(new Set(edited.clips.map((item) => item.id)).size, edited.clips.length);
});

test('replacement removes a range then inserts the replacement at that seam', () => {
  const source = draft(clip('a', 0, 10), clip('b', 0, 4));
  const edited = replaceWorkbenchClipRange(source, 'a', { startSec: 3, endSec: 7 }, clip('new', 5, 9));
  assert.deepEqual(edited.clips.map((item) => [item.id, item.inSec, item.outSec]), [['a', 0, 3], ['new', 5, 9], ['a-tail', 7, 10], ['b', 0, 4]]);
  assert.deepEqual(edited.clips[0].transitionAfter, { type: 'cut', durationSec: 0 });
  assert.deepEqual(edited.clips[1].transitionAfter, { type: 'cut', durationSec: 0 });
});

test('trim clamps crossfade duration when the edited clip becomes short', () => {
  const source = draft(clip('a', 0, 10, { type: 'crossfade', durationSec: 4 }), clip('b', 0, 2));
  const edited = trimWorkbenchClipRange(source, 'a', { startSec: 2, endSec: 3 });
  assert.deepEqual(edited.clips[0].transitionAfter, { type: 'crossfade', durationSec: 0.5 });
});
