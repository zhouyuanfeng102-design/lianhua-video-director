import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const readCspDirectives = (html) => {
  const metaTag = html.match(/<meta\b(?=[^>]*\bhttp-equiv=["']Content-Security-Policy["'])[^>]*>/iu)?.[0];
  assert.ok(metaTag, 'index.html must declare a Content-Security-Policy meta tag');
  const policy = metaTag.match(/\bcontent=(["'])(.*?)\1/iu)?.[2];
  assert.ok(policy, 'Content-Security-Policy meta tag must have a non-empty content attribute');
  return new Map(policy.split(';').map((directive) => directive.trim()).filter(Boolean).map((directive) => {
    const [name, ...values] = directive.split(/\s+/u);
    return [name.toLowerCase(), values];
  }));
};

test('renderer CSP blocks executable injection while preserving supported API and media sources', () => {
  const directives = readCspDirectives(indexHtml);

  assert.deepEqual(directives.get('default-src'), ["'self'"]);
  assert.ok(directives.get('script-src')?.includes("'self'"));
  for (const unsafeSource of ["'unsafe-eval'", "'unsafe-inline'"]) {
    assert.ok(!directives.get('script-src')?.includes(unsafeSource), `script-src must reject ${unsafeSource}`);
  }
  assert.deepEqual(directives.get('object-src'), ["'none'"]);
  assert.deepEqual(directives.get('base-uri'), ["'self'"]);
  assert.deepEqual(directives.get('frame-src'), ["'none'"]);
  assert.equal(directives.has('frame-ancestors'), false, 'frame-ancestors is ignored in a meta-delivered policy');

  for (const source of ["'self'", 'http:', 'https:', 'ws:', 'wss:']) {
    assert.ok(directives.get('connect-src')?.includes(source), `connect-src must allow ${source}`);
  }
  for (const directive of ['img-src', 'media-src']) {
    for (const source of ["'self'", 'data:', 'blob:', 'http:', 'https:', 'lianhua-asset:']) {
      assert.ok(directives.get(directive)?.includes(source), `${directive} must allow ${source}`);
    }
  }
});
