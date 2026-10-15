import assert from 'node:assert/strict';
import { formatVideoHttpError } from '../src/videoHttpError';

const html = formatVideoHttpError(413, `<!DOCTYPE html><html><head><title>413 Request Entity Too Large</title>
  <style>.secret-style { content: 'hidden-style-value'; }</style></head>
  <body><h1>请求体过大</h1><script>const secret = 'hidden-script-value';</script>
  <p>Upload &amp; retry &#x4E0A;&#20256;</p></body></html>`, {
  requestBytes: 106.22 * 1024 * 1024,
  requestContentType: 'application/json; charset=utf-8',
});
assert.match(html, /HTTP 413/u);
assert.match(html, /106\.22 MiB，application\/json/u);
assert.match(html, /请求体过大/u);
assert.match(html, /Upload & retry 上传/u);
assert.match(html, /压缩参考图片.*URL／文件上传/u);
assert.doesNotMatch(html, /hidden-script-value|hidden-style-value|<html|100\s*M/iu);

const structured = formatVideoHttpError(429, {
  code: 0,
  error: { code: 'quota_exceeded', message: 'quota exceeded; api_key=secret-value; private request' },
  base_resp: { status_msg: 'Please retry later', status_code: 1002 },
});
assert.match(structured, /HTTP 429/u);
assert.match(structured, /error\.code=quota_exceeded/u);
assert.match(structured, /code=0/u);
assert.match(structured, /base_resp\.status_code=1002/u);
assert.match(structured, /quota exceeded/u);
assert.match(structured, /Please retry later/u);
assert.doesNotMatch(structured, /secret-value|private request/u);

const rawJson = formatVideoHttpError(400, '{"error":{"code":"invalid_input","message":"图片不受支持"}}');
assert.match(rawJson, /invalid_input/u);
assert.match(rawJson, /图片不受支持/u);
assert.match(formatVideoHttpError(502, 'upstream unavailable'), /HTTP 502[\s\S]*upstream unavailable/u);

const payload = formatVideoHttpError(400, `Image failed data:image/png;base64,${'A'.repeat(2000)} Token was echoed`);
assert.match(payload, /Image failed/u);
assert.doesNotMatch(payload, /AAAA|base64,|Token was echoed/u);
assert.doesNotMatch(formatVideoHttpError(401, 'Authorization: Bearer private-token-value'), /private-token-value/u);

const huge = formatVideoHttpError(413, '失败'.repeat(20_000), { requestBytes: 64 * 1024 * 1024 });
assert.ok(huge.length <= 2_000);
assert.match(huge, /HTTP 413/u);
assert.match(huge, /64\.00 MiB/u);
assert.match(huge, /压缩参考图片/u);
assert.match(huge, /已截断/u);
assert.doesNotMatch(formatVideoHttpError(413, '', { requestBytes: Number.NaN }), /NaN/u);

let accessorRead = false;
const accessorError = Object.defineProperty({}, 'message', { get: () => { accessorRead = true; throw new Error('do not invoke'); } });
const empty = formatVideoHttpError(500, accessorError);
assert.equal(accessorRead, false);
assert.match(empty, /HTTP 500/u);
assert.match(empty, /未提供可读/u);
assert.doesNotMatch(formatVideoHttpError(413, '<script>private-script-without-close'), /private-script/u);

const echoed = formatVideoHttpError(413, 'upload failed: opaque-credential-42; 保密的完整生成提示词', {
  knownSecrets: ['opaque-credential-42'], sensitiveTexts: ['保密的完整生成提示词'],
});
assert.match(echoed, /upload failed/u);
assert.doesNotMatch(echoed, /opaque-credential-42|保密的完整生成提示词/u);

console.log('video HTTP error HTML/text extraction, status/code preservation, 413 size guidance, redaction and bounds checks passed');
