import assert from 'node:assert/strict';
import { getImageVariantGenerationSpec } from '../src/imageGeneration';
import { IMAGE_STORY_SPATIAL_STATE_RULE } from '../src/spatialContinuityRules';

assert.match(IMAGE_STORY_SPATIAL_STATE_RULE, /人物身体和脚步朝向已采用剧情的目的地/u);
assert.match(IMAGE_STORY_SPATIAL_STATE_RULE, /后移跟拍、正面跟拍只说明摄影机在人物前方沿来路后退/u);
assert.match(IMAGE_STORY_SPATIAL_STATE_RULE, /也不把目的地画在他们身后/u);
assert.match(IMAGE_STORY_SPATIAL_STATE_RULE, /人物参考图只锁脸和衣服/u);
assert.match(getImageVariantGenerationSpec('first-frame').direction, /先写人物往哪走、摄影机在哪、画面背后是什么/u);
assert.match(getImageVariantGenerationSpec('storyboard-frame').direction, /后移跟拍不把目的地画到人物身后/u);
console.log('storyboard travel direction checks passed');
