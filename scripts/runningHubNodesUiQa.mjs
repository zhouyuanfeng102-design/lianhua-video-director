import assert from 'node:assert/strict';

// Used by a caller-owned persistent Playwright browser/Electron session. Never
// launch a browser or submit a generation request from this fixture.
export const QA_INVENTORY = [
  'Empty nodeInfoList: visible read/import guidance and zero image slots; never invent node IDs or require manual image-slot addition.',
  'Read structure with fake credentials: actual UI click -> documented read-only POST -> usable prompt/image/parameter choices, no generation endpoint.',
  'Select prompt + automatically listed image, edit one numeric default: only those three fields join nodeInfoList; addMetadata, queue and unrelated cloud defaults stay unchanged.',
  'Node JSON and manual inputs: import API-format JSON, add a real field, reject malformed JSON / widget-only canvas, retain existing request overrides.',
  'Cancel/retry read, search prompt/parameter fields, save/reopen: image slots have no pagination, values and node directory persist independently.',
  'Off-happy path: delayed response after changing ID/closing must not write; failed/unauthorized read shows actionable message and allows retry.',
  'Visual: empty, loaded, mapping, parameter, import and manual dialogs at 1280x800 and 1120x720 with 100/130% text; native desktop startup + mapping/footer fit.',
];

export const EMPTY_CURL = `curl --request POST 'https://www.runninghub.ai/openapi/v2/run/workflow/2093983063180054529' --header 'Authorization: Bearer example-key-not-imported' --data-raw '{"addMetadata":true,"nodeInfoList":[],"instanceType":"default","usePersonalQueue":"false"}'`;
export const API_GRAPH = JSON.stringify({
  '21': { class_type: 'CLIPTextEncode', _meta: { title: '视频正文提示词' }, inputs: { text: 'cloud prompt', clip: ['9', 0] } },
  '22': { class_type: 'LoadImage', _meta: { title: '首帧参考图' }, inputs: { image: 'cloud-reference.png', upload: 'image' } },
  '23': { class_type: 'KSampler', _meta: { title: '采样设置' }, inputs: { seed: 314, steps: 20, cfg: 7.5, sampler_name: 'euler', model: ['9', 0] } },
  '24': { class_type: 'PrimitiveBoolean', _meta: { title: '保持音频' }, inputs: { value: true } },
  '25': { class_type: 'SecretNode', inputs: { api_key: 'do-not-import-secret' } },
});
export const METADATA_RESPONSE = { code: 0, msg: 'SUCCESS', data: { prompt: API_GRAPH } };

export function assertSelectedRequest(source) {
  const request = JSON.parse(source);
  assert.equal(request.addMetadata, true);
  assert.equal(request.instanceType, 'default');
  assert.equal(request.usePersonalQueue, false);
  assert.deepEqual(request.nodeInfoList.map(({ nodeId, fieldName }) => `${nodeId}.${fieldName}`).sort(), ['21.text', '22.image', '23.steps']);
  assert.equal(request.nodeInfoList.find((node) => node.nodeId === '23').fieldValue, 32);
  assert.equal(source.includes('do-not-import-secret'), false);
  assert.equal(source.includes('sampler_name'), false);
}

export async function inspectFit(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('.rhv-manager');
    if (!dialog) throw new Error('RunningHub manager is not visible');
    const checks = [...dialog.querySelectorAll('.vwm-header,.vwm-footer,.rhv-node-tools,.vwm-collection-footer,.rhv-node-dialog,.rhv-node-dialog > footer,.vwm-parameter-item,.vwm-mapping-item,.rhv-image-slot-card')]
      .filter((node) => node.getClientRects().length)
      .map((node) => {
        const box = node.getBoundingClientRect();
        return { className: node.className, x: box.x, y: box.y, width: box.width, height: box.height,
          inViewport: box.x >= 0 && box.y >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1 };
      });
    return { width: innerWidth, height: innerHeight, checks, pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
}
