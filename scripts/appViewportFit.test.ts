import assert from 'node:assert/strict';
import { calculateAppViewportFit } from '../src/appViewportFit';

const fit = (width: number, height: number) => {
  const result = calculateAppViewportFit(width, height);
  assert.ok(result);
  return result;
};

const desktop = fit(1600, 900);
assert.equal(desktop.scale, 1);
assert.equal(desktop.layoutWidth, 1600);
assert.equal(desktop.layoutHeight, 900);

const short = fit(1400, 700);
assert.ok(short.scale < 1 && short.scale > 0.8);
assert.ok(Math.abs(short.layoutWidth * short.scale - 1400) < 0.01);
assert.ok(Math.abs(short.layoutHeight * short.scale - 700) < 0.01);
assert.ok(short.layoutHeight >= 800);
assert.ok(short.layoutWidth >= 1280);

const narrow = fit(1000, 760);
assert.ok(narrow.layoutWidth >= 1280);
assert.ok(narrow.layoutHeight >= 800);
assert.ok(Math.abs(narrow.layoutWidth * narrow.scale - 1000) < 0.01);

assert.equal(calculateAppViewportFit(0, 800), null);
assert.equal(calculateAppViewportFit(1280, Number.NaN), null);

console.log('app viewport fit: passed');
