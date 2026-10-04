import type { StylePreset } from './types';

export type VisualStylePresetRules = Pick<StylePreset, 'visual' | 'camera' | 'lighting' | 'sound'>;

export interface VisualStyleDefinition {
  readonly id: string;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly category: string;
  readonly promptAnchor: string;
  readonly stylePresetId: string;
  readonly preset: Readonly<VisualStylePresetRules>;
}

const visualStyleDefinitionData = [
  {
    id: 'cinematic_realism',
    name: '电影写实',
    category: '写实',
    promptAnchor: '色彩：中性暖灰基调配克制青橙层次；材质：皮肤、织物、木石与金属保留真实磨损和反射；光影：有动机的自然主光、环境反射与柔和空气透视；氛围：可信、沉浸且克制；质感：细腻35mm电影颗粒、自然景深与稳定动态范围',
    stylePresetId: 'style_cinema',
    preset: {
      visual: '电影级写实质感，真实材质，可信空间和自然光源，克制的色彩层次',
      camera: '稳定电影摄影，景别清晰，必要时缓慢推拉和精准跟拍',
      lighting: '主光源明确，保留环境反射、空气透视和自然阴影',
      sound: '环境声真实，动作声有层次，音乐只在转折和结果处强调',
    },
  },
  {
    id: 'documentary',
    name: '纪录片',
    category: '写实',
    promptAnchor: '色彩：自然低修饰色温与轻微褪色；材质：旧墙、日常织物、皮肤纹理和使用痕迹如实呈现；光影：现场可用光、窗光与不完美曝光；氛围：观察式、诚实且贴近当下；质感：轻微高感颗粒、真实焦点游移与手持呼吸感',
    stylePresetId: 'style_documentary',
    preset: {
      visual: '保留现场原貌、人物真实肤质和环境中的偶发细节，不做过度美化或布景化处理',
      camera: '以28mm至50mm肩扛观察、跟随和及时重构图为主，只在信息交代时使用固定大全景',
      lighting: '优先使用窗光、顶灯和街灯等现场光源，仅补足人物眼神与关键动作的可辨度',
      sound: '同期对白优先，完整保留房间底噪、街道远声和动作原声，配乐不得覆盖事实信息',
    },
  },
  {
    id: 'korean_portrait',
    name: '韩式偶像',
    category: '写实',
    promptAnchor: '色彩：奶油白、浅粉与清透暖肤色；材质：细腻皮肤、丝绸、玻璃和洁净金属；光影：大面积柔光、明亮眼神光与轻薄轮廓光；氛围：精致、浪漫且亲近；质感：高清柔焦、浅景深与干净商业人像润饰',
    stylePresetId: 'style_korean_portrait',
    preset: {
      visual: '面部比例、妆发和服装轮廓始终一致，肤色通透但保留毛孔，背景控制在柔和散景层',
      camera: '以50mm和85mm中近景、正反打及缓慢横移突出眼神和细微表情，避免广角面部变形',
      lighting: '用大型柔光塑造正面肤质，以低强度发丝轮廓光分离背景，并保住高光细节',
      sound: '对白保持近讲清晰，衣料与饰品声轻而可闻，城市底声和轻柔电子乐维持低位',
    },
  },
  {
    id: 'vintage_film',
    name: '复古胶片',
    category: '写实',
    promptAnchor: '色彩：褪色琥珀、高光奶白与阴影青绿；材质：旧木、皮革、黄铜和泛黄纸张；光影：暖灯晕染、窗边漏光与轻微炫光；氛围：怀旧、温柔并带时间痕迹；质感：16mm或35mm颗粒、细微闸门抖动和克制划痕',
    stylePresetId: 'style_vintage_film',
    preset: {
      visual: '画面保留年代器物、服装做旧和胶片宽容度，高光允许柔和溢出但人物轮廓必须清楚',
      camera: '固定机位、缓慢摇摄和人工感变焦交替，构图参考旧式新闻与家庭电影，不使用高速穿越',
      lighting: '以钨丝灯、窗光和实景台灯形成暖色主光，逆光处允许胶片光晕但不吞没主体',
      sound: '加入轻微磁带底噪、机械声和年代环境声，音乐采用小编制并避开现代重低音',
    },
  },
  {
    id: 'black_cinema',
    name: '黑色电影',
    category: '写实',
    promptAnchor: '色彩：黑白或近单色的冷灰高反差；材质：湿沥青、百叶窗、烟雾、旧皮衣与抛光金属；光影：硬侧光、切割阴影和强轮廓逆光；氛围：疑惧、孤立且道德暧昧；质感：浓重35mm颗粒、深黑层次与锐利明暗边缘',
    stylePresetId: 'style_black_cinema',
    preset: {
      visual: '用雨夜街道、狭窄室内和几何阴影组织线索，关键面孔只暴露必要区域并保持道具可读',
      camera: '采用低机位、俯视、过肩遮挡与少量荷兰角，调查段缓推，揭露瞬间切到紧特写',
      lighting: '让百叶窗、门缝、路灯和桌灯成为可见光源，以硬光切面并保留大面积负补光',
      sound: '突出雨声、鞋跟、门轴、霓虹电流和远处警笛，爵士低音只在悬念间隙进入',
    },
  },
  {
    id: 'short_drama',
    name: '短剧质感',
    category: '写实',
    promptAnchor: '色彩：清晰暖肤色配现代中性色和适量高饱和重点色；材质：当代玻璃、精整木面、服装面料与手机屏幕清楚可辨；光影：明亮面部主光、柔和轮廓和受控背景亮度；氛围：直接、情绪集中且节奏紧凑；质感：锐利数字影像、洁净肤质与竖屏安全构图',
    stylePresetId: 'style_short_drama',
    preset: {
      visual: '人物表情、关系站位和关键道具优先于环境装饰，服化与场景保持连续并适配小屏观看',
      camera: '以35mm双人景、50mm单人景和反应特写快速衔接，冲突点使用短促推近并严格匹配视线',
      lighting: '人物脸部保持一至两档亮度优势，以柔光和实际灯具建立方向，避免背景抢占注意力',
      sound: '对白置于最前层，动作落点清楚，转折可用短促提示音，配乐在台词期间主动让位',
    },
  },
  {
    id: 'korean_mood',
    name: '韩系氛围',
    category: '写实',
    promptAnchor: '色彩：雾灰、鼠尾草绿、奶油色与低饱和暖棕；材质：柔软针织、浅木、磨砂玻璃和潮湿窗面；光影：阴天漫射、窗边柔亮与室内暖灯点缀；氛围：安静、治愈并带含蓄距离；质感：低反差胶片色调、柔和高光和细颗粒散景',
    stylePresetId: 'style_korean_mood',
    preset: {
      visual: '用留白、生活小物和天气细节承载情绪，人物服装与空间色调保持低饱和协调',
      camera: '以50mm和85mm静置构图、门框取景及极慢横移观察停顿，避免频繁切换和夸张运镜',
      lighting: '窗外冷漫射光负责轮廓，室内暖灯负责局部层次，面部对比柔和且不过度提亮',
      sound: '保留雨滴、咖啡机、翻页和远处交通等生活声，轻柔器乐以长间隔进入',
    },
  },
  {
    id: 'raw_camera',
    name: '毛边美学',
    category: '艺术',
    promptAnchor: '色彩：脏灰、暗绿和偏移肤色形成不规整低饱和；材质：粗墙、划伤金属、皱布和汗湿皮肤；光影：现场硬光、偶发炫光与局部过曝；氛围：迫近、不安且未经修饰；质感：高感噪点、色差、失焦边缘和真实手持拖影',
    stylePresetId: 'style_raw_camera',
    preset: {
      visual: '保留污渍、汗水、凌乱背景和曝光波动，主体动作必须可读但画面不追求商业洁净度',
      camera: '用24mm或35mm贴身手持跟随，允许短暂遮挡、呼吸式漂移和重新对焦，不做平滑环绕',
      lighting: '依赖裸灯、车灯、窗光等现场硬光，少量负补光强化表面，不抹平过曝与暗部差异',
      sound: '保留呼吸、脚步、衣物摩擦和空间反射，音乐稀少，现场声的距离变化跟随镜位',
    },
  },
  {
    id: 'sports_event',
    name: '赛事体育',
    category: '写实',
    promptAnchor: '色彩：队伍识别色鲜明、草地与场馆中性色准确；材质：汗湿皮肤、球衣织物、橡胶、草屑和金属器械清晰；光影：高强度场馆灯与锐利日光冻结动作；氛围：竞争、爆发且充满现场能量；质感：高快门锐度、广播级对比和关键瞬间慢动作细节',
    stylePresetId: 'style_sports_event',
    preset: {
      visual: '比分线索、边界、器械和运动员号码保持可辨，动作姿态符合项目力学并连续交代攻防关系',
      camera: '长焦追踪核心对抗，大全景交代阵型，低机位展示速度，只在决定性落点使用高速慢放',
      lighting: '日赛保持自然方向与地面反光，夜赛校正场馆灯频闪并让运动员从观众席背景分离',
      sound: '分层记录观众浪潮、裁判哨、器械撞击和运动员呼吸，解说与现场声互不遮盖',
    },
  },
  {
    id: 'republic_vintage',
    name: '民国复古',
    category: '国风',
    promptAnchor: '色彩：茶褐、墨蓝、旧玉绿与克制暗红；材质：旗袍丝缎、风化木门、黄铜和磨砂玻璃；光影：格窗斜光、钨丝暖灯与烟尘光束；氛围：含蓄、旧梦般优雅并潜藏时代张力；质感：细颗粒胶片、柔化高光和年代印刷色层',
    stylePresetId: 'style_republic_vintage',
    preset: {
      visual: '建筑、招牌、服饰和器物遵循民国年代语汇，避免现代塑料与电子设备穿帮，人物轮廓保持端正',
      camera: '以40mm环境中景、75mm人物近景和走廊对称构图为主，缓慢推轨揭示关系与隐情',
      lighting: '用格窗日光切出空间层级，以桌灯和壁灯补暖面部，烟尘仅用于显出光路',
      sound: '组织电车铃、黄包车轮、木门、雨檐和室内钟声，留声机音乐只来自明确的场内声源',
    },
  },
  {
    id: 'anime_movie',
    name: '动画电影',
    category: '动画',
    promptAnchor: '色彩：高纯度天空蓝、植物绿与夕照暖橙形成清澈分区；材质：赛璐璐角色面、手绘背景笔触和简化高光；光影：动画化体积光、干净轮廓光与情绪化色温转换；氛围：明快、冒险且富有抒情张力；质感：稳定线稿、分层2D景深和电影级手绘细节',
    stylePresetId: 'style_anime_movie',
    preset: {
      visual: '角色线条、色块和比例跨镜稳定，背景采用可读的手绘层次，动作关键姿势必须轮廓鲜明',
      camera: '使用动画电影式广角建立、横向追逐和透视推近，快速动作以关键帧和清晰运动弧线组织',
      lighting: '以天空、夕阳或室内实景灯建立主色，使用简洁阴影块和轮廓亮边强化情绪转折',
      sound: '动作拟音与画面关键帧精确同步，环境层保持空间感，管弦或主题旋律在段落高潮展开',
    },
  },
  {
    id: 'ink_fantasy',
    name: '水墨幻想',
    category: '国风',
    promptAnchor: '色彩：墨黑、宣纸白配少量朱砂与石青；材质：宣纸纤维、水墨洇染、干笔飞白和矿物颜料；光影：大面积留白中的柔亮云光与淡金边缘；氛围：空灵、诗意且超脱现实；质感：湿墨扩散、笔锋纹路和山水长卷式层次',
    stylePresetId: 'style_ink_fantasy',
    preset: {
      visual: '人物与山水由可识别的笔墨轮廓构成，墨迹变化服务动作和空间，朱砂只标示叙事焦点',
      camera: '沿横卷缓移、穿越墨云和由远山推至人物，转场可用墨滴扩散或留白显形，避免机械旋转',
      lighting: '用纸面留白作为主亮区，以墨色浓淡塑造体积，在神异元素边缘加入有限淡金辉光',
      sound: '风、水、鸟鸣与衣袂保持疏朗，古琴、箫和鼓点按笔墨动作落位，留出明显静默段',
    },
  },
  {
    id: 'dream_surreal',
    name: '梦境超现实',
    category: '幻想',
    promptAnchor: '色彩：薰衣草紫、月光青与柔粉渐变发生非现实过渡；材质：液态镜面、薄纱、云层和悬浮玻璃；光影：无明确来源的柔光、反常长影与局部虹彩；氛围：迷离、宁静又隐约不安；质感：柔焦晕光、漂浮颗粒和无缝形态变形',
    stylePresetId: 'style_dream_surreal',
    preset: {
      visual: '保持人物身份与核心物件稳定，让尺度、重力或空间连接每次只改变一项，形成可读的梦境逻辑',
      camera: '以缓慢漂移、无切口穿越和不可能的镜面转场连接空间，变化发生前先给出清晰视觉参照',
      lighting: '采用环境自发光、反常影向和柔和色温漂移，主体眼睛与动作边缘始终留有辨识光',
      sound: '使用倒放尾音、拉长房间混响和远近错位的生活声，低频只在空间规则改变时出现',
    },
  },
  {
    id: 'no_style',
    name: '无附加风格',
    category: '中性',
    promptAnchor: '',
    stylePresetId: 'style_neutral',
    preset: {
      visual: '只执行故事、角色、场景和用户已有的视觉约束，不额外施加固定媒介、年代或调色倾向',
      camera: '镜头只服务动作可读性、空间关系和叙事节奏，不套用特定流派的标志性运镜',
      lighting: '依据场景中可见光源建立方向、曝光和阴影，确保主体与关键道具清楚可辨',
      sound: '保留与场景和动作直接相关的环境声、对白与效果声，不额外指定音乐类型',
    },
  },
  {
    id: 'tv_anime_cel',
    name: 'TV番剧赛璐璐',
    category: '动画2D',
    promptAnchor: '色彩：清亮角色固有色、干净背景分区和适度高饱和重点色；材质：平涂赛璐璐角色面、简化衣料纹理和手绘背景色块；光影：两到三档硬边阴影、少量高光块和清晰轮廓光；氛围：轻快、稳定且适合连续番剧叙事；质感：干净线稿、稳定色块、有限动画关键帧和低噪点2D合成',
    stylePresetId: 'style_tv_anime_cel',
    preset: {
      visual: 'TV番剧赛璐璐质感，干净线稿、平涂色块、硬边阴影和稳定角色比例，背景细节服从主体可读性',
      camera: '以动画分镜式中景、特写和建立镜头为主，运动依靠清楚关键姿势与少量平移推拉完成',
      lighting: '使用明确色温和硬边阴影分层，脸部与关键动作保持明亮可读，避免写实复杂反射',
      sound: '对白与动作拟音清楚贴合关键帧，环境声简洁，轻快配乐按镜头节奏进入和退出',
    },
  },
  {
    id: 'shonen_action_anime',
    name: '热血少年番',
    category: '动画2D',
    promptAnchor: '色彩：高对比主角色、能量色和冲击背景速度线；材质：粗细变化线稿、夸张衣料褶皱、能量火花和碎片特效；光影：强轮廓边光、爆发闪光和动作阴影块；氛围：热血、速度感强且招式落点明确；质感：夸张透视、动势残影、漫画拟声感和高张力2D动作作画',
    stylePresetId: 'style_shonen_action_anime',
    preset: {
      visual: '热血少年番动作作画，角色轮廓夸张但身份稳定，招式轨迹、速度线、能量色和冲击碎片清楚可读',
      camera: '低机位冲刺、快速推近、横向追击和反应特写交替，必杀技必须包含起手、蓄力、接触和结果',
      lighting: '用强轮廓光、能量自发光和爆发闪光强化动作方向，但主体服装色和面部信息不能被吞没',
      sound: '拳脚、武器、能量蓄力和冲击声按动作阶段分层，主题旋律只在逆转、登场和必杀命中时抬升',
    },
  },
  {
    id: 'shojo_soft_anime',
    name: '少女漫画动画',
    category: '动画2D',
    promptAnchor: '色彩：柔粉、奶油白、浅紫和透明暖肤色构成低压甜美调；材质：细线稿、透明发丝、花瓣、蕾丝和柔软针织以简化纹理表现；光影：大面积柔光、星点眼神光和轻薄高光晕；氛围：浪漫、细腻且情绪亲近；质感：柔焦2D合成、轻颗粒、花纹背景和漫画分格式情绪符号',
    stylePresetId: 'style_shojo_soft_anime',
    preset: {
      visual: '少女漫画动画质感，细线稿、柔和肤色、透明发丝、花瓣或星点情绪背景，人物表情和眼神光保持精致',
      camera: '以中近景、眼神特写和缓慢推近表达情绪，双人关系用留白和视线方向组织，不做激烈甩镜',
      lighting: '大面积柔光塑造肤色和发丝，高光晕只围绕面部与情绪道具，背景保持低对比',
      sound: '衣料、发饰和脚步声轻柔，环境声低位，钢琴、弦乐或清亮音色随情绪转折细腻进入',
    },
  },
  {
    id: 'anime_illustration_paint',
    name: '厚涂动漫插画',
    category: '动画2D',
    promptAnchor: '色彩：分层冷暖互补、角色重点色和环境反射色融合；材质：厚涂笔触、柔化边缘、织物纹理和半写实皮肤高光；光影：绘画式体积光、渐变阴影和局部高饱和反光；氛围：精致、华丽且适合封面级定格；质感：高完成度数字插画、可见笔触层次和2D角色设计感',
    stylePresetId: 'style_anime_illustration_paint',
    preset: {
      visual: '厚涂动漫插画质感，角色设计感明确，服装纹理、发丝层次、环境反光和绘画笔触共同服务封面级画面',
      camera: '优先使用稳定构图、三分法或中心构图，中近景突出角色，大全景保留插画式前中后景层次',
      lighting: '绘画式体积光和渐变阴影塑造立体感，局部反光增强材质，但不走照片写实路线',
      sound: '适合插画化镜头的音乐和环境声保持克制，动作声只强调关键姿态变化和道具接触',
    },
  },
  {
    id: 'toon_3d_anime',
    name: '三渲二动漫',
    category: '动画3D',
    promptAnchor: '色彩：2D动漫固有色和3D空间环境色统一控制；材质：卡通着色角色面、描边轮廓、简化PBR材质和手绘贴图；光影：阶梯式toon阴影、清晰边缘光和可控屏幕空间高光；氛围：动漫角色感强且运动稳定；质感：3D骨骼动画、2D描边、稳定透视和三渲二合成',
    stylePresetId: 'style_toon_3d_anime',
    preset: {
      visual: '三渲二动漫质感，3D角色使用卡通着色和描边，保留2D动漫脸部比例、发丝块面和稳定服装结构',
      camera: '3D镜头可平滑环移和跟拍，但构图保持动画分镜逻辑，避免真实相机畸变破坏动漫比例',
      lighting: '使用阶梯式toon阴影、边缘光和少量屏幕空间高光，角色脸部阴影形状必须稳定',
      sound: '动作拟音按3D运动节奏精确同步，角色台词靠前，电子或管弦配乐服务动漫段落情绪',
    },
  },
  {
    id: 'stylized_3d_cartoon',
    name: '卡通3D动画',
    category: '动画3D',
    promptAnchor: '色彩：明亮原色、糖果色点缀和清楚冷暖空间层级；材质：圆润PBR塑形、柔软毛发、布料、塑料和木石的卡通化表面；光影：大面积柔光、弹性高光和干净反射；氛围：活泼、亲切且适合合家欢冒险；质感：圆润建模、夸张表情、平滑动画曲线和电影级3D渲染',
    stylePresetId: 'style_stylized_3d_cartoon',
    preset: {
      visual: '卡通3D动画质感，圆润形体、夸张表情、干净材质和高可读色彩，角色比例与道具尺度跨镜稳定',
      camera: '平滑推拉、低幅度环绕和清楚景别切换，动作段落保留弹性预备、压缩和回弹结果',
      lighting: '柔和面积主光与环境反弹保持明亮亲和，彩色高光只强化材质和情绪焦点',
      sound: '拟音可适度夸张，脚步、碰撞和表情动作有弹性，配乐明亮但不压对白',
    },
  },
  {
    id: 'game_cg_anime',
    name: '游戏CG动漫',
    category: '动画3D',
    promptAnchor: '色彩：角色阵营识别色、技能能量色和高反差场景光统一；材质：精细3D服装、硬表面装甲、武器特效和半写实皮肤着色；光影：电影级全局光、技能自发光、粒子辉光和清晰轮廓分离；氛围：华丽、史诗且具有游戏过场动画张力；质感：高精度建模、动态粒子、英雄展示镜头和实时CG渲染',
    stylePresetId: 'style_game_cg_anime',
    preset: {
      visual: '游戏CG动漫质感，高精度角色模型、阵营识别色、武器与技能粒子保持连续，画面有过场动画的展示性',
      camera: '英雄登场用低机位和环绕展示，战斗用跟拍、特写和大全景交代技能范围，镜头运动平滑但节奏强',
      lighting: '全局光与技能自发光并存，粒子辉光照亮邻近材质，关键角色轮廓始终与背景分离',
      sound: '武器、技能、粒子爆发和环境回响分层明确，主题音乐在角色登场和技能释放时增强',
    },
  },
  {
    id: 'chibi_3d_cute',
    name: 'Q版3D萌系',
    category: '动画3D',
    promptAnchor: '色彩：马卡龙浅色、奶油白和小面积高饱和萌点；材质：软塑、绒毛、圆润织物和玩具般高光；光影：均匀柔光、短小软阴影和圆形眼神光；氛围：可爱、轻松且具有玩具箱世界感；质感：Q版大头比例、圆角建模、弹性动作和干净3D卡通渲染',
    stylePresetId: 'style_chibi_3d_cute',
    preset: {
      visual: 'Q版3D萌系质感，大头短身比例、圆角建模、软塑和绒毛材质清楚，表情夸张但身份特征稳定',
      camera: '低高度近景、轻微俯拍和小幅跟拍突出可爱体量，动作使用弹跳和停顿表现情绪',
      lighting: '均匀柔光、短软阴影和圆形眼神光，避免硬恐怖阴影或写实粗糙纹理',
      sound: '轻巧脚步、弹跳、软碰撞和小道具声突出，音乐使用明亮短句并保留对白清晰',
    },
  },
  {
    id: 'post_apocalyptic_wasteland',
    name: '末日废土',
    category: '科幻',
    promptAnchor: '色彩：灰橙低饱和，天空与地表呈尘土褪色层次；材质：锈蚀金属、破败混凝土、裂纹橡胶与风化布料；光影：灼白日光和硬质逆光切出残骸轮廓；氛围：风沙尘雾笼罩无人地带，形成空旷压迫感；质感：粗粝颗粒、热浪扭曲和附着尘土的干燥表面',
    stylePresetId: 'style_post_apocalyptic_wasteland',
    preset: {
      visual: '用残垣、废弃机械、稀缺水源和人物防护装备建立生存尺度，所有物件呈现长期风化与修补痕迹',
      camera: '超广角静置展现孤立尺度，中长焦压缩沙暴层次，人物移动使用低位跟拍并让残骸持续遮挡',
      lighting: '以高位烈日或低角度硬逆光为唯一主导，尘雾显出光束，脸部只保留有限反射补光',
      sound: '突出持续风压、砂砾击打、松动金属和远处结构呻吟，人声干涩贴近，音乐保持稀薄低频',
    },
  },
  {
    id: 'cyberpunk_night',
    name: '赛博朋克夜城',
    category: '科幻',
    promptAnchor: '色彩：电青、洋红、酸性紫与深蓝夜色高反差交错；材质：雨湿沥青、镀铬义体、玻璃幕墙和透明塑料；光影：霓虹招牌、屏幕闪烁与车辆逆光形成混合色源；氛围：拥挤、躁动且技术压迫；质感：变形宽银幕光斑、雨雾反射和锐利数字细节',
    stylePresetId: 'style_cyberpunk_night',
    preset: {
      visual: '广告层、街巷人群、义体接口和潮湿表面分出前中后景，霓虹色必须对应可见光源',
      camera: '用24mm穿行建立城市密度，50mm贴近人物交易和追踪，车辆段落采用低位平行跟拍与短促甩镜',
      lighting: '控制电青与洋红的主次，屏幕光照亮面部信息，雨地反光延伸空间但不造成全画面同亮',
      sound: '叠加雨水、通风机、广告广播、交通与义体伺服声，低频合成器随追逐速度上升',
    },
  },
  {
    id: 'hard_scifi_space',
    name: '硬科幻太空',
    category: '科幻',
    promptAnchor: '色彩：冷白、钢蓝、信号橙与深空纯黑；材质：拉丝钛合金、复合隔热层、强化玻璃和磨损舱壁；光影：舱内功能灯、仪表辉光与无空气衰减的硬太阳光；氛围：理性、孤绝且尺度宏大；质感：高解析工程细节、准确真空反射和克制大画幅清晰度',
    stylePresetId: 'style_hard_scifi_space',
    preset: {
      visual: '航天器结构、接口、姿态控制和失重物体遵循工程逻辑，界面信息简洁并固定在可信载体上',
      camera: '外景以稳定远景交代轨道和相对速度，舱内使用广角固定或缓移，失重运动保持惯性连续',
      lighting: '太空外景采用单一硬太阳光与黑色负空间，舱内由状态灯分区，警报只改变局部色温',
      sound: '舱外事件通过舱体振动和无线电表现而非真空传声，舱内保留风机、继电器、呼吸和束缚带声',
    },
  },
  {
    id: 'biopunk',
    name: '生物科幻',
    category: '科幻',
    promptAnchor: '色彩：淤紫、病绿、血红与冷白实验室色形成生理反差；材质：半透明膜、湿润组织、甲壳、黏液和不锈钢器械；光影：脉动生物荧光、冷顶灯与液体折射；氛围：有机、幽闭且令人不适；质感：微距血管细节、黏滞高光和可见呼吸收缩',
    stylePresetId: 'style_biopunk',
    preset: {
      visual: '生物结构保持可追踪的骨骼、膜层和接口逻辑，成长或变异按阶段发生并保留前一状态痕迹',
      camera: '先用微距展示细胞或表面反应，再拉至中景交代宿主关系；追逐时贴近有机通道并避免无因旋转',
      lighting: '冷实验灯揭示结构，生物荧光只从组织内部渗出，湿表面高光随脉动节奏变化',
      sound: '组合湿润收缩、液体循环、甲壳摩擦和设备泵鸣，低频心跳随生物反应而非剪辑任意加速',
    },
  },
  {
    id: 'dieselpunk',
    name: '柴油朋克',
    category: '科幻',
    promptAnchor: '色彩：煤烟棕、军用橄榄、氧化红与钨丝琥珀；材质：铆接钢板、油污皮革、厚橡胶和黄铜仪表；光影：探照灯、炉火与穿透机油烟雾的硬光束；氛围：沉重、机械化且战时紧迫；质感：粗颗粒、积碳、震动和厚重工业磨损',
    stylePresetId: 'style_dieselpunk',
    preset: {
      visual: '机械结构以齿轮、活塞、管线和可维护铆钉构成，服装与载具体现油污、补丁和长期服役痕迹',
      camera: '低机位广角强化机器体量，沿传动机构横移交代运作，战斗段用受控手持和长焦观察压缩',
      lighting: '炉火与钨丝灯提供暖区，探照灯切开冷烟，仪表亮度受控并对应设备状态',
      sound: '柴油机、活塞、蒸汽泄压、金属共振与皮靴声分层同步，铜管和军鼓只强化动员节奏',
    },
  },
  {
    id: 'kaiju_disaster',
    name: '巨兽灾难',
    category: '灾难',
    promptAnchor: '色彩：风暴灰、火焰橙和警报红笼罩城市；材质：断裂混凝土、裸露钢筋、碎玻璃、积水与巨兽湿润表皮；光影：闪电、火场反光和尘云后的巨大逆光轮廓；氛围：失控、惊惧且具有压倒性尺度；质感：高速碎屑、空气震波、浓烟层次和新闻现场般锐度',
    stylePresetId: 'style_kaiju_disaster',
    preset: {
      visual: '持续用建筑、车辆和人群作为尺度参照，破坏沿受力路径推进，巨兽身体结构和伤痕跨镜一致',
      camera: '地面低机位跟随撤离者，远景交代巨兽全貌，长焦捕捉建筑坍塌；冲击前后保持明确空间轴线',
      lighting: '风暴天光为底，火场和警灯提供局部暖色，巨兽轮廓通过闪电或尘后逆光短暂显现',
      sound: '按距离组织警报、人群、结构断裂、冲击延迟和巨兽低吼，近距离爆裂后加入短暂听觉闷塞',
    },
  },
  {
    id: 'tokusatsu_drama',
    name: '特摄剧',
    aliases: ['特摄电影写实'],
    category: '科幻',
    promptAnchor: '色彩：高饱和英雄识别色、银色装甲高光、城市中性灰与爆破橙红形成鲜明对照；材质：可触摸的皮套、涂装硬甲、橡胶褶皱、微缩建筑和实体烟尘火花保留手作细节；光影：摄影棚硬主光、彩色轮廓光与有明确来源的变身和必杀光效；氛围：正邪对峙、英雄登场和必杀收束具有热血而清楚的特摄剧仪式感；质感：实拍皮套、微缩模型、现场爆破与克制光学合成共同构成经典特摄剧影像，避免纯CG塑料感',
    stylePresetId: 'style_tokusatsu_drama',
    preset: {
      visual: '以实拍皮套、涂装硬甲、微缩城市和现场爆破建立特摄剧质感；英雄头盔目镜、胸甲纹样、识别色、变身器与固定武器跨镜一致，怪兽皮套结构、伤痕和微缩建筑比例连续',
      camera: '用低机位广角塑造英雄与怪兽体量，以快速推近、侧向跟拍、反应特写和大全景交代攻防；必杀技先给清楚起手、蓄力与目标，再在接触和爆破落点切换，保持轴线与动作可读性',
      lighting: '摄影棚硬主光和高饱和彩色轮廓光勾勒皮套与装甲，变身、能量和必杀光只照亮邻近材质；现场爆破允许短暂高亮，但必须保留主体轮廓、涂装色和微缩景深',
      sound: '分层组织变身器提示音、皮套摩擦、沉重脚步、武器挥击、微缩建筑碎裂、现场爆破和怪兽吼声；英雄主题动机只在登场、变身和必杀结果处强化',
    },
  },
  {
    id: 'wuxia',
    name: '国风武侠',
    category: '国风',
    promptAnchor: '色彩：青灰、竹绿、墨黑与烛火暖金克制对照；材质：真实木石、粗布、丝绸、旧铜与有使用痕迹的兵器；光影：月光、窗格光、雨幕逆光和烛火局部照明；氛围：肃杀、飘逸且讲究江湖留白；质感：东方武侠电影颗粒、清晰衣摆运动和空气水汽层次',
    stylePresetId: 'style_wuxia',
    preset: {
      visual: '国风武侠电影质感，真实木石、布料、金属和雨雾材质，克制的青灰与暖金色彩',
      camera: '低机位、跟拍、环绕和遮挡切换服务于动作可读性',
      lighting: '月光、烛火、雨幕和逆光形成明确的冷暖关系',
      sound: '风雨、衣摆、兵器接触和脚步声清晰，音乐在招式结果处落点',
    },
  },
  {
    id: 'oriental_myth',
    name: '东方神话',
    category: '国风',
    promptAnchor: '色彩：朱砂、鎏金、石青和深墨构成庄重综合色；材质：古玉、青铜、织金丝绸、神木与翻涌云海；光影：天门光束、神火、金色轮廓与层叠云影；氛围：神圣、雄浑且充满远古仪式感；质感：工笔纹样、壁画矿物色和宏大电影景深',
    stylePresetId: 'style_oriental_myth',
    preset: {
      visual: '神祇服饰、法器和建筑纹样遵循统一文化母题，以凡人、山岳和天门建立神话尺度',
      camera: '大全景沿山河或祭坛升起，中心对称构图呈现仪式，神力发动时由人物中景推进至法器细节',
      lighting: '自然天光维持世界底色，神火与金色辉光只绑定明确法器或神祇，云层遮放形成节奏',
      sound: '钟磬、鼓、风雷和低声吟唱分层进入，法器启动有独立音色，宏大音乐为对白留出空间',
    },
  },
  {
    id: 'xianxia_cloud',
    name: '仙侠云境',
    category: '国风',
    promptAnchor: '色彩：云白、冰青、淡金与浅紫保持高明度层次；材质：半透明轻纱、温润白玉、云气和镜面水台；光影：漫射天光、柔和边缘光与云隙金辉；氛围：清逸、宁静且超凡脱俗；质感：洁净高调影像、细腻雾层和流动衣袂轨迹',
    stylePresetId: 'style_xianxia_cloud',
    preset: {
      visual: '仙门建筑、云阶、法衣和灵力纹路保持轻盈统一，人物御空轨迹有明确起点、方向与落点',
      camera: '以远景展现云海层级，沿云阶平稳上升，人物飞行使用侧向跟拍和缓慢环移避免失去方位',
      lighting: '大面积天空漫射光维持通透，淡金轮廓勾勒白衣，法术光只短暂改变局部云色',
      sound: '高空风、铃佩、衣袂和远瀑构成轻声环境，箫与空灵弦乐稀疏铺陈，法术落点清楚',
    },
  },
  {
    id: 'dark_fantasy',
    name: '黑暗奇幻',
    category: '幻想',
    promptAnchor: '色彩：焦黑、血红、霉绿与冷月蓝压低明度；材质：腐蚀铠甲、骨骼、湿石、粗皮革和枯木；光影：烛火、月光与深重负空间形成强烈明暗切割；氛围：宿命、危险且古老压抑；质感：厚重油画暗部、污垢颗粒和潮湿表面细节',
    stylePresetId: 'style_dark_fantasy',
    preset: {
      visual: '怪物、遗迹和盔甲呈现可追踪的年代与损伤，魔法代价通过身体或环境的持续变化表现',
      camera: '缓慢低机位进入遗迹，长焦窥视危险，战斗保持沉重惯性与完整招式落点，不用轻快漂浮运镜',
      lighting: '以月光、火把和裂隙辉光分区，负补光保留威胁，关键符文只照亮邻近材质',
      sound: '盔甲重量、湿石回声、远兽鸣与火焰构成压迫空间，低沉合唱只在仪式或命运转折出现',
    },
  },
  {
    id: 'refined_3d',
    name: '精致3D动画',
    category: '动画',
    promptAnchor: '色彩：协调宝石色与清晰冷暖分区；材质：PBR织物、陶瓷、木材、金属和皮肤次表面散射细致区分；光影：柔和面积主光、环境反弹与干净轮廓光；氛围：亲切、明快且具有动画电影叙事感；质感：精细建模、平滑曲面、稳定角色比例和受控景深',
    stylePresetId: 'style_3d',
    preset: {
      visual: '精致3D动画质感，清晰轮廓、细腻材质、稳定角色比例和富有层次的环境',
      camera: '动画电影镜头，运动平滑，景别变化服务叙事，不做无意义旋转',
      lighting: '柔和主光与轮廓光，保持角色脸部和关键道具可辨',
      sound: '动作声清晰，环境声简洁，音乐突出节奏和情绪高潮',
    },
  },
  {
    id: 'stop_motion_clay',
    name: '定格黏土',
    category: '动画',
    promptAnchor: '色彩：泥土暖色、复古原色与手工涂料的不均匀色块；材质：黏土指纹、毛毡、纸板、木片和外露细金属线；光影：微缩摄影棚硬柔混合光与真实桌面阴影；氛围：童趣、古怪并带手作温度；质感：逐格轻微抖动、可见塑形痕迹和浅景深微缩感',
    stylePresetId: 'style_stop_motion_clay',
    preset: {
      visual: '保留黏土指纹、接缝和手工布景边缘，角色体积与道具尺度跨镜一致，变形遵循逐格塑形逻辑',
      camera: '采用微缩台面高度的固定机位、短滑轨和俯拍，运动保留轻微逐格顿挫但动作轮廓清楚',
      lighting: '用可感知的棚灯方向塑造微缩阴影，实景小灯提供暖点，高光不得抹掉黏土表面纹理',
      sound: '脚步、挤压、纸板碰撞和小型机械使用夸张拟音，木琴与拨弦按逐格动作节拍进入',
    },
  },
  {
    id: 'suspense_thriller',
    name: '悬疑惊悚',
    category: '悬疑',
    promptAnchor: '色彩：低饱和蓝灰、病态黄绿与少量警示红；材质：潮湿墙面、划伤玻璃、旧纸和磨损金属；光影：局部实景灯、深阴影、反射和有限可见区域；氛围：压迫、疑惧且线索密布；质感：低照度颗粒、冷硬细节和缓慢显露的暗部层次',
    stylePresetId: 'style_suspense',
    preset: {
      visual: '低饱和电影质感，潮湿表面、局部细节和压迫空间，保留可辨认的视觉线索',
      camera: '缓慢推进、过肩、遮挡和突然的尺度跳切',
      lighting: '局部光源、深阴影、反射和有限可见区域',
      sound: '环境底噪、远处声源、呼吸和细小物件声逐步增强',
    },
  },
  {
    id: 'gothic_horror',
    name: '哥特恐怖',
    category: '恐怖',
    promptAnchor: '色彩：煤黑、暗酒红、冷月蓝与陈旧象牙白；材质：潮湿石墙、彩窗玻璃、天鹅绒、锻铁和滴蜡；光影：月光穿过尖拱和彩窗，烛火在深阴影中摇曳；氛围：华丽、腐朽且充满宗教性恐惧；质感：精细明暗画法、雾气层次和古老油画般表面',
    stylePresetId: 'style_gothic_horror',
    preset: {
      visual: '尖拱、长廊、祭坛、旧肖像和服装纹样共享一致年代，恐怖线索先以局部材质或影子出现',
      camera: '沿长廊中轴缓慢推进，以高角俯视孤立人物，门框和柱廊持续遮挡，显形瞬间切至静止近景',
      lighting: '冷月光负责建筑轮廓，烛火负责面部局部，彩窗投色限定在光路内并保留大片深黑空间',
      sound: '管风琴低音、风穿石缝、木门、钟声和衣摆回响建立纵深，静默后只保留最近的呼吸或蜡滴声',
    },
  },
] as const satisfies readonly VisualStyleDefinition[];

export const visualStyleDefinitions: readonly VisualStyleDefinition[] = Object.freeze(
  visualStyleDefinitionData.map((definition) => Object.freeze({
    ...definition,
    ...('aliases' in definition ? { aliases: Object.freeze([...definition.aliases]) } : {}),
    preset: Object.freeze({ ...definition.preset }),
  })),
);

const LEGACY_VISUAL_STYLE_PRESET_IDS = new Set<string>([
  'style_cinema',
  'style_wuxia',
  'style_3d',
  'style_suspense',
]);

export const NEW_ANIME_VISUAL_STYLE_PRESET_IDS: readonly string[] = Object.freeze([
  'style_tv_anime_cel',
  'style_shonen_action_anime',
  'style_shojo_soft_anime',
  'style_anime_illustration_paint',
  'style_toon_3d_anime',
  'style_stylized_3d_cartoon',
  'style_game_cg_anime',
  'style_chibi_3d_cute',
]);

export const NEW_VISUAL_STYLE_PRESET_IDS: readonly string[] = Object.freeze(
  visualStyleDefinitions
    .map(({ stylePresetId }) => stylePresetId)
    .filter((stylePresetId) => !LEGACY_VISUAL_STYLE_PRESET_IDS.has(stylePresetId)),
);

export const findVisualStyleDefinition = (value: string): VisualStyleDefinition | undefined => {
  const normalizedValue = value.trim();
  if (!normalizedValue) return undefined;
  return visualStyleDefinitions.find(
    ({ id, name, aliases }) => (
      id === normalizedValue
      || name === normalizedValue
      || aliases?.includes(normalizedValue)
    ),
  );
};

export const resolveVisualStyleSelectDisplay = (
  value: string,
): { value: string; compatibility: boolean } => {
  const definition = findVisualStyleDefinition(value);
  if (definition) return { value: definition.name, compatibility: false };
  return value.trim()
    ? { value, compatibility: true }
    : { value: '', compatibility: false };
};

export const resolveVisualStylePrompt = (value: string): string => {
  const normalizedValue = value.trim();
  return findVisualStyleDefinition(normalizedValue)?.promptAnchor ?? normalizedValue;
};

export const matchedStylePresetId = (value: string): string | undefined =>
  findVisualStyleDefinition(value)?.stylePresetId;

export const applyVisualStyleSelection = (
  value: string,
  availablePresetIds: readonly string[],
  currentPresetId: string,
): { visualStyle: string; stylePresetId: string; matched: boolean } => {
  const definition = findVisualStyleDefinition(value);
  const fallbackPresetId = availablePresetIds.includes(currentPresetId)
    ? currentPresetId
    : availablePresetIds[0] ?? currentPresetId;
  if (!definition) {
    return {
      visualStyle: value,
      stylePresetId: fallbackPresetId,
      matched: false,
    };
  }

  const matched = availablePresetIds.includes(definition.stylePresetId);
  return {
    visualStyle: definition.name,
    stylePresetId: matched ? definition.stylePresetId : fallbackPresetId,
    matched,
  };
};

export const createBuiltInVisualStylePresets = (timestamp: number): StylePreset[] =>
  visualStyleDefinitions.map(({ stylePresetId, name, category, preset }) => ({
    id: stylePresetId,
    name,
    category,
    ...preset,
    updatedAt: timestamp,
  }));
