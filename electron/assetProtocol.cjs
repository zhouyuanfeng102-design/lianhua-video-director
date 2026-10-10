const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac' };

// Chromium's file fetch can read a Range but returns a 200 Response without its
// byte boundaries. Re-wrapping that response in a custom protocol loses seeking.
const byteRange = (header, size) => {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) return null;
  if (first === undefined) return last > 0 ? { start: Math.max(0, size - last), end: size - 1 } : null;
  if (first >= size || (last !== undefined && last < first)) return null;
  return { start: first, end: last === undefined ? size - 1 : Math.min(last, size - 1) };
};

const contentType = async (filePath) => {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.mov' || extension === '.mp4') {
    const file = await fs.promises.open(filePath, 'r');
    try {
      const bytes = Buffer.alloc(16);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
        // Downloaded MP4s may retain a .mov name; use the real container brand.
        return bytes.toString('ascii', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
      }
    } finally { await file.close(); }
  }
  return TYPES[extension] || 'application/octet-stream';
};

const aborted = () => Object.assign(new Error('Asset request cancelled'), { name: 'AbortError' });

const createAssetProtocolHandler = ({ assetPathFromRelative }) => async (request) => {
  let filePath;
  try {
    const url = new URL(request.url);
    if (url.protocol !== 'lianhua-asset:' || url.hostname !== 'local') throw new Error('Invalid asset origin');
    const relativePath = url.pathname.split('/').filter(Boolean).map(decodeURIComponent).join('/');
    filePath = assetPathFromRelative(relativePath);
  } catch { return new Response('Invalid asset path', { status: 400 }); }
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return new Response('Asset not found', { status: 404 });
    const headers = new Headers({ 'Accept-Ranges': 'bytes', 'Content-Type': await contentType(filePath), 'Cache-Control': 'no-cache', 'Last-Modified': stat.mtime.toUTCString() });
    // HEAD describes the complete file. Only GET applies a byte range.
    const range = request.method === 'HEAD' ? undefined : byteRange(request.headers.get('range'), stat.size);
    if (range === null) {
      headers.set('Content-Range', `bytes */${stat.size}`);
      headers.set('Content-Length', '0');
      return new Response(null, { status: 416, headers });
    }
    const length = range ? range.end - range.start + 1 : stat.size;
    headers.set('Content-Length', String(length));
    if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
    if (request.method === 'HEAD' || stat.size === 0) return new Response(null, { status: 200, headers });
    if (request.signal.aborted) throw aborted();
    const stream = fs.createReadStream(filePath, range || {});
    const body = Readable.toWeb(stream);
    const cancel = () => stream.destroy(aborted());
    request.signal.addEventListener('abort', cancel, { once: true });
    stream.once('close', () => request.signal.removeEventListener('abort', cancel));
    if (request.signal.aborted) cancel();
    return new Response(body, { status: range ? 206 : 200, headers });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return new Response('Asset not found', { status: error?.code === 'ENOENT' ? 404 : 500 });
  }
};

module.exports = { createAssetProtocolHandler, byteRange };
