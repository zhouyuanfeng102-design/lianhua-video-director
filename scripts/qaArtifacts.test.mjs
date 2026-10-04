import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const artifactsModule = await import('./qaArtifacts.mjs').catch((loadError) => ({ loadError }));
const root = path.resolve(import.meta.dirname, '..');

test('optional QA artifacts report their own failure without rejecting the functional smoke', async () => {
  assert.equal(typeof artifactsModule.captureOptionalQaArtifact, 'function', artifactsModule.loadError?.message);
  const failure = new Error('CDP command timed out: Page.captureScreenshot');

  assert.equal(
    await artifactsModule.captureOptionalQaArtifact('Electron screenshot', async () => { throw failure; }),
    'Electron screenshot: CDP command timed out: Page.captureScreenshot',
  );
  assert.equal(await artifactsModule.captureOptionalQaArtifact('Electron screenshot', async () => {}), null);
});

for (const scriptName of ['electronSmoke.mjs', 'mediaUiSmoke.mjs']) {
  test(`${scriptName} treats only screenshot capture as an optional QA artifact`, () => {
    const source = fs.readFileSync(path.join(root, 'scripts', scriptName), 'utf8');
    assert.match(source, /captureOptionalQaArtifact\([^,]+,\s*async\s*\(\)\s*=>\s*\{[\s\S]*?Page\.captureScreenshot[\s\S]*?\}\)/u);
    assert.match(source, /screenshotError/u);
  });
}
