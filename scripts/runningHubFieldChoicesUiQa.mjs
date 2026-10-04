// A fixture for a caller-owned persistent Playwright/Electron session.
// All nodes are synthetic. No credentials, production project or cloud generation.
export { EMPTY_CURL } from './runningHubNodesUiQa.mjs';
export const QA_INVENTORY = [
  'Dense internal directory: prompt defaults to text candidates; every real image input is listed automatically, not arbitrary internal fields or invented node IDs.',
  'Advanced scope + ID/name/title search can reveal custom/negative/model inputs; current selections remain visible across filters.',
  'Prompt/parameter filtering and searching do not dirty saved settings; automatic image synchronization is an unsaved draft until explicit save.',
  'Parameters show common fields and existing request overrides; advanced retains the complete directory, ordinary search still works.',
  'Bind a suggested field, save/reopen, and verify the chosen value plus original addMetadata/runtime options; existing 137 catalogs need no refetch.',
  'Off-path: unknown existing binding and missing binding remain inspectable; no common match explains the advanced fallback.',
  'Six image slots all visible with read-only node/field and editable roles; no add/remove/node-select/pagination controls; 1366x768, 1280x800 and 1120x720 with 100/130% fonts.',
];

const internalInputs = { model_name: 'model.safetensors', sampler_name: 'euler', scheduler: 'normal', filename_prefix: 'video', format: 'video/h264-mp4', custom_input: 'custom entry' };
for (let index = Object.keys(internalInputs).length; index < 62; index += 1) internalInputs[`internal_${index}`] = `kept ${index}`;
export const GRAPH = {
  '11': { class_type: 'CLIPTextEncode', _meta: { title: '正向视频提示词' }, inputs: { text: 'cloud positive' } },
  '12': { class_type: 'CLIPTextEncode', _meta: { title: '负向提示词' }, inputs: { text: 'cloud negative' } },
  '13': { class_type: 'PrimitiveString', _meta: { title: '长剧情视频提示词' }, inputs: { value: 'cloud alternate' } },
  '21': { class_type: 'LoadImage', _meta: { title: '首帧参考图' }, inputs: { image: 'cloud.png', upload: 'image' } },
  '22': { class_type: 'ReferenceImage', _meta: { title: '人物参考图' }, inputs: { reference_image: '' } },
  '31': { class_type: 'VideoSettings', inputs: { width: 1280, height: 720, duration: 8, seed: 42, steps: 20, fps: 24 } },
  '90': { class_type: 'InternalOptions', _meta: { title: '内部与自定义设置' }, inputs: internalInputs },
};
export const METADATA_RESPONSE = { code: 0, msg: 'SUCCESS', data: { prompt: JSON.stringify(GRAPH) } };

export const SIX_IMAGE_GRAPH = {
  ...GRAPH,
  '23': { class_type: 'LoadImage', _meta: { title: '人物二参考图' }, inputs: { image: 'None' } },
  '24': { class_type: 'LoadImage', _meta: { title: '人物三参考图' }, inputs: { image: 'None' } },
  '25': { class_type: 'LoadImage', _meta: { title: '场景参考图' }, inputs: { image: 'None' } },
  '26': { class_type: 'LoadImage', _meta: { title: '额外参考图' }, inputs: { image: 'old-cloud-image.png' } },
};

export async function inspectFieldChoicesFit(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.rhv-manager');
    if (!root) throw new Error('Open the RunningHub manager first');
    const visible = (el) => el.getClientRects().length > 0;
    const regions = [...root.querySelectorAll('.vwm-header,.rhv-node-tools,.rhv-field-filters,.vwm-mapping-item,.rhv-image-slot-card,.vwm-parameter-item,.vwm-collection-footer,.vwm-footer,.rhv-runtime-help,.rhv-cost-note,.vwm-tab-panel > .field,.vwm-tab-panel > .rhv-two-fields')].filter(visible).map(el => {
      const box = el.getBoundingClientRect();
      let inside = box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1;
      for (let parent = el.parentElement; parent && parent !== root; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (/(?:auto|hidden|scroll|clip)/.test(style.overflowY)) {
          const bounds = parent.getBoundingClientRect();
          inside &&= box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1;
        }
      }
      return { className: el.className, inside, x: box.x, y: box.y, width: box.width, height: box.height };
    });
    return { width: innerWidth, height: innerHeight, regions,
      lists: [...root.querySelectorAll('.vwm-mapping-list,.vwm-parameter-list,.vwm-tab-panel')].filter(visible).map(el => ({ className: el.className, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight })),
      pageOverflowX: document.documentElement.scrollWidth > innerWidth + 1 };
  });
}
