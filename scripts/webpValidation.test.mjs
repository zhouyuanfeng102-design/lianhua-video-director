import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { isCompleteWebP } = require('../electron/webpValidation.cjs');
const samples = require('./fixtures/generatedImageSamples.json');

test('real SFW lossy/lossless/extended WebP containers are accepted without rewriting metadata or bytes', () => {
  for (const name of ['webp', 'webpLossless', 'webpExtended']) {
    const bytes = Buffer.from(samples[name], 'base64');
    const original = Buffer.from(bytes);
    assert.equal(isCompleteWebP(bytes), true, name);
    assert.deepEqual(bytes, original);
    assert.equal(isCompleteWebP(Buffer.concat([bytes, Buffer.from([0, 0, 32, 10])])), true, 'reasonable tail padding is not a broken image');
  }
});

test('truncated, fake RIFF and malformed VP8/VP8L/VP8X chunks remain rejected', () => {
  for (const name of ['webp', 'webpLossless', 'webpExtended']) {
    const bytes = Buffer.from(samples[name], 'base64');
    for (const length of [0, 11, 19, bytes.length - 1]) assert.equal(isCompleteWebP(bytes.subarray(0, length)), false, `${name} truncation at ${length}`);
    const overflow = Buffer.from(bytes); overflow.writeUInt32LE(0xffffffff, 16);
    assert.equal(isCompleteWebP(overflow), false, `${name} oversized chunk`);
    assert.equal(isCompleteWebP(Buffer.concat([bytes, Buffer.from('<html>error</html>')])), false);
  }
  const lossy = Buffer.from(samples.webp, 'base64'); lossy[23] = 0;
  assert.equal(isCompleteWebP(lossy), false, 'lossy keyframe signature must remain valid');
  const lossless = Buffer.from(samples.webpLossless, 'base64'); lossless[20] = 0;
  assert.equal(isCompleteWebP(lossless), false, 'lossless frame signature must remain valid');
  const badVersion = Buffer.from(samples.webpLossless, 'base64'); badVersion[24] |= 0xe0;
  assert.equal(isCompleteWebP(badVersion), false, 'unsupported lossless version is not a valid frame');
  const extended = Buffer.from(samples.webpExtended, 'base64'); extended[20] |= 0x80;
  assert.equal(isCompleteWebP(extended), false, 'extended reserved flags cannot be arbitrary bytes');
  assert.equal(isCompleteWebP(Buffer.from('RIFFxxxxWEBPerror-body')), false);
  assert.equal(isCompleteWebP(Buffer.from('{"error":"not an image"}')), false);
});
