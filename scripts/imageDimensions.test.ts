import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readGeneratedImageDimensions } from '../src/imageDimensions';

const samples = JSON.parse(readFileSync(new URL('./fixtures/generatedImageSamples.json', import.meta.url), 'utf8')) as Record<string, string>;
for (const format of ['png', 'jpeg', 'webp', 'webpLossless', 'webpExtended']) {
  const encoded = samples[format];
  assert.deepEqual(readGeneratedImageDimensions(encoded), { width: 2, height: 2 }, `${format} actual header dimensions`);
  assert.deepEqual(readGeneratedImageDimensions(`data:image/png;base64,${encoded}`), { width: 2, height: 2 }, 'a mislabeled provider response must use the file signature');
}
const png = Buffer.from(samples.png, 'base64');
const tallPng = Buffer.from(png);
tallPng.writeUInt32BE(1024, 16);
tallPng.writeUInt32BE(2048, 20);
assert.deepEqual(readGeneratedImageDimensions(tallPng.toString('base64')), { width: 1024, height: 2048 }, 'reads encoded pixels; never a requested 4K fallback');
const zeroPng = Buffer.from(png);
zeroPng.writeUInt32BE(0, 16);
assert.equal(readGeneratedImageDimensions(zeroPng.toString('base64')), undefined);
const malformedPng = Buffer.from(png);
malformedPng.writeUInt32BE(1, 8);
assert.equal(readGeneratedImageDimensions(malformedPng.toString('base64')), undefined);
const truncatedJpeg = Buffer.from(samples.jpeg, 'base64').subarray(0, 140).toString('base64');
const truncatedWebp = Buffer.from(samples.webp, 'base64').subarray(0, 25).toString('base64');
for (const invalid of ['', 'https://example.test/result.png', 'not image pixels', 'data:image/png;base64,AAAA', png.subarray(0, 24).toString('base64'), truncatedJpeg, truncatedWebp]) {
  assert.equal(readGeneratedImageDimensions(invalid), undefined, 'unavailable/invalid dimensions must remain unknown');
}
console.log('Image dimension metadata checks passed (PNG, JPEG, WebP lossy/lossless/extended, malformed/remote results).');
