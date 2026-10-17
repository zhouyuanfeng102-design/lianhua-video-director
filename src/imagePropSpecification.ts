/** Dependency-free prop contracts. Catalogs read these during module
 * initialization, so this leaf must not import generation or project code. */
export const PROP_THREE_VIEW_CANVAS = { width: 1536, height: 1024 } as const;

/** One physical prop shown from three cameras, rather than three props or
 * three output files. Shared by source prompts and every converter format. */
export const PROP_THREE_VIEW_LAYOUT_RULE = [
  '单张横向3:2物品三视图参考板，恰好三个等宽全高区域，从左到右依次为正面、严格90度左侧面、背面，每个视角只出现一次',
  '三个区域展示同一且唯一的物品，保持同一尺度、同一相机高度、同一水平基线，完整轮廓、突出部件和附属连接件均收在各自区域内，不裁切、不遮挡、不跨格、不重叠',
  '使用正交或低透视标准视角，保持真实纵横比例、厚度与连接关系；侧面只呈现真实厚度，不把正面图案复制到侧面或背面，不镜像替代侧面或背面，不用45度透视替代90度侧面',
  '三个视角共享同一形状、部件数量、材质、配色、纹理、识别标记、磨损和当前状态；展开/收起、开启/关闭、发光/熄灭均采用资料指定的同一状态，不拼接动作过程或变形步骤',
  '只依据当前物品资料与实际参考图维持设计，未见面只作与已知结构相容的克制补全，不增加无依据的按钮、刀刃、纹样、组件、包装或底座',
  '真实多组件物品按资料保持同一组装关系，不拆成爆炸图；柔性、透明、发光及不规则物品保持稳定形态、结构与观察方向',
  '统一简洁中性背景、统一柔和照明和用户指定视觉风格，物品独立展示，不添加手、持物人物、尺寸线、文字、编号、Logo或水印，不增加第四视图、局部插图或额外物品',
  '这是一张图片中的三个观察面，不是三件独立物品，也不是三张输出图片；参考图只锁定物品身份、设计与材质，当前三视图规格决定布局和观察角度',
].join('；') + '。';

/** Multi-view negatives must allow the three intentional depictions. */
export const PROP_THREE_VIEW_NEGATIVE_PROMPT = 'extra fourth view, repeated angle, extra inset, exploded view, mismatched prop between views, inconsistent components, inconsistent material, inconsistent state, mirrored side view, front design copied onto back, overlapping views, cropped prop, broken geometry, distorted proportions, wide-angle distortion, fisheye distortion, unrelated object, human hand, person, text, logo, watermark';

/** Conditional guidance is shared by generic, themed and model-family rules. */
export const IMAGE_PROMPT_PROP_SPECIFICATION_RULE = [
  '独立物品按当前画面规格组织：特写只展示一个物品的指定局部或近距离主体，保留材质、纹理、磨损和功能部件，不强制拉远补全轮廓。',
  '仅当当前规格明确为物品三视图时，执行同一物品的正面、严格90度左侧面、背面三区域参考板；这是一个物品的三个观察角度，允许这三次必要展示，不适用笼统的“禁止重复物品”或“只允许一个画面”限制。',
  PROP_THREE_VIEW_LAYOUT_RULE,
  '以上三视图布局只适用于当前明确选择三视图的请求；其他规格及历史图标、展示图继续按各自原有取景，不自动扩展为多视图。自然语言直接描述可见画面，SD/NAI用等价结构与视角标签；没有人物出镜时不创建人物段。',
].join('\n');
