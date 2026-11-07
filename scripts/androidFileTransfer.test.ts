import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ANDROID_FILE_TRANSFER_CHUNK, ANDROID_FILE_TRANSFER_THRESHOLD, withNativeFile, type LianhuaNativePlugin } from '../src/platform/androidBridge';

const bytes = new Uint8Array(ANDROID_FILE_TRANSFER_THRESHOLD + 73);
for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 73 + (index >> 8)) % 256;
const selected = new File([bytes], '包含素材的项目.lhvd', { type: 'application/octet-stream' });
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

function fixture(failAt?: number) {
  const calls: string[] = [];
  const chunks: Buffer[] = [];
  let tempPresent = false;
  let received = 0;
  const plugin: Pick<LianhuaNativePlugin, 'invoke'> = {
    async invoke({ method, payload }) {
      calls.push(method);
      if (method === 'beginFileTransfer') {
        assert.deepEqual(payload, { fileName: selected.name, mimeType: selected.type, sizeBytes: selected.size });
        tempPresent = true;
        return { value: { transferId: 'file-1' } };
      }
      assert.equal(payload?.transferId, 'file-1');
      if (method === 'appendFileTransfer') {
        assert.equal(tempPresent, true);
        assert.equal(payload.offset, received, 'chunks must be sent in order without gaps');
        const chunk = Buffer.from(String(payload.base64), 'base64');
        assert.ok(chunk.length <= ANDROID_FILE_TRANSFER_CHUNK);
        if (chunks.length === failAt) throw new Error('transfer interrupted');
        chunks.push(chunk);
        received += chunk.length;
        return { value: { receivedBytes: received } };
      }
      if (method === 'finishFileTransfer') {
        assert.equal(received, selected.size);
        return { value: { uri: 'file:///private-cache/file-1', fileName: selected.name, mimeType: selected.type } };
      }
      if (method === 'abortFileTransfer') {
        tempPresent = false;
        return { value: true };
      }
      throw new Error(`unexpected method: ${method}`);
    },
  };
  return { plugin, calls, chunks, isPresent: () => tempPresent };
}

const success = fixture();
const value = await withNativeFile(success.plugin, selected, async (payload) => {
  assert.equal(success.isPresent(), true, 'temporary bytes must survive until the native importer copies them');
  assert.equal(payload.uri, 'file:///private-cache/file-1');
  assert.equal(payload.fileName, selected.name);
  assert.equal('dataUrl' in payload, false, 'a large selected file must not be encoded as one bridge message');
  assert.equal(digest(Buffer.concat(success.chunks)), digest(bytes), 'all binary bytes must survive ordered chunking');
  return 'managed-import';
});
assert.equal(value, 'managed-import');
assert.equal(success.isPresent(), false);
assert.equal(success.calls.filter((method) => method === 'appendFileTransfer').length, Math.ceil(selected.size / ANDROID_FILE_TRANSFER_CHUNK));
assert.deepEqual(success.calls.slice(-2), ['finishFileTransfer', 'abortFileTransfer']);

const interrupted = fixture(1);
let consumed = false;
await assert.rejects(withNativeFile(interrupted.plugin, selected, async () => { consumed = true; }), /transfer interrupted/);
assert.equal(consumed, false);
assert.equal(interrupted.isPresent(), false);
assert.deepEqual(interrupted.calls, ['beginFileTransfer', 'appendFileTransfer', 'appendFileTransfer', 'abortFileTransfer'], 'an interrupted chunk must be cleaned up without retries or finalizing incomplete bytes');

const importFailure = fixture();
await assert.rejects(withNativeFile(importFailure.plugin, selected, async () => { throw new Error('invalid project archive'); }), /invalid project archive/);
assert.equal(importFailure.isPresent(), false, 'import failure must also remove completed temporary files');
assert.equal(importFailure.calls.at(-1), 'abortFileTransfer');
console.log('Android file transfer: binary concatenation, ordering and interruption cleanup passed');
