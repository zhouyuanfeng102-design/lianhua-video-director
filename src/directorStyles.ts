export const directorStyleCategories = [
  '全部',
  '科幻',
  '动作',
  '特摄',
  '东方',
  '二次元',
  '悬疑',
  '视觉',
  '战争',
  '文艺',
] as const;

export type DirectorStyleCategory = (typeof directorStyleCategories)[number];
export type SpecificDirectorStyleCategory = Exclude<DirectorStyleCategory, '全部'>;

export interface DirectorStylePreset {
  readonly id: string;
  readonly name: string;
  readonly category: SpecificDirectorStyleCategory;
  readonly summary: string;
  readonly scene: string;
}

export const directorStylePresets: readonly DirectorStylePreset[] = [
  {
    id: 'standard_cinema',
    name: '标准电影感',
    category: '视觉',
    summary: '叙事清晰、镜头克制',
    scene: '通用场景',
  },
  {
    id: 'christopher_nolan',
    name: '克里斯托弗·诺兰',
    category: '科幻',
    summary: '冷峻史诗、时间张力',
    scene: '悬疑、科幻、宏大叙事',
  },
  {
    id: 'james_cameron',
    name: '詹姆斯·卡梅隆',
    category: '动作',
    summary: '高速动作、工业奇观',
    scene: '动作、科幻、灾难',
  },
  {
    id: 'denis_villeneuve',
    name: '丹尼斯·维伦纽瓦',
    category: '科幻',
    summary: '极简巨构、压迫空间',
    scene: '史诗科幻、荒凉场景',
  },
  {
    id: 'steven_spielberg',
    name: '史蒂文·斯皮尔伯格',
    category: '文艺',
    summary: '温暖冒险、人文调度',
    scene: '冒险、家族、奇遇',
  },
  {
    id: 'martin_scorsese',
    name: '马丁·斯科塞斯',
    category: '动作',
    summary: '街头能量、快速剪辑',
    scene: '帮派、都市、冲突',
  },
  {
    id: 'david_fincher',
    name: '大卫·芬奇',
    category: '悬疑',
    summary: '阴冷精密、心理压迫',
    scene: '悬疑、犯罪、暗调',
  },
  {
    id: 'alfonso_cuaron',
    name: '阿方索·卡隆',
    category: '文艺',
    summary: '长镜头、沉浸调度',
    scene: '写实、灾难、长镜头',
  },
  {
    id: 'zhang_yimou',
    name: '张艺谋',
    category: '东方',
    summary: '浓烈色彩、仪式构图',
    scene: '国风、战争、宫廷',
  },
  {
    id: 'wong_kar_wai',
    name: '王家卫',
    category: '文艺',
    summary: '暧昧霓虹、情绪慢镜',
    scene: '情感、都市、记忆',
  },
  {
    id: 'li_an',
    name: '李安',
    category: '东方',
    summary: '克制诗意、东方留白',
    scene: '武侠、情感、家庭',
  },
  {
    id: 'kurosawa',
    name: '黑泽明',
    category: '战争',
    summary: '风雨动态、群像调度',
    scene: '战争、古装、群像',
  },
  {
    id: 'ridley_scott',
    name: '雷德利·斯科特',
    category: '科幻',
    summary: '厚重美术、工业暗光',
    scene: '科幻、历史、战争',
  },
  {
    id: 'quentin_tarantino',
    name: '昆汀·塔伦蒂诺',
    category: '动作',
    summary: '强烈段落、对峙张力',
    scene: '对峙、复仇、黑色幽默',
  },
  {
    id: 'satoshi_kon',
    name: '今敏',
    category: '二次元',
    summary: '梦境剪辑、现实错位',
    scene: '梦境、心理、幻象',
  },
  {
    id: 'miyazaki',
    name: '宫崎骏',
    category: '二次元',
    summary: '自然幻想、飞行诗意',
    scene: '奇幻、治愈、冒险',
  },
  {
    id: 'koichi_sakamoto',
    name: '坂本浩一',
    category: '特摄',
    summary: '动作段落强调清晰的攻防轴线、低机位跟拍、腾跃与威亚运动，并以实景爆破交代力量落点',
    scene: '英雄近战、团队战、追逐与决战',
  },
  {
    id: 'kiyotaka_taguchi',
    name: '田口清隆',
    category: '特摄',
    summary: '用地面视角和人物参照建立巨物尺度，结合皮套表演、微缩城市、尘烟碎屑与克制的数字合成',
    scene: '巨兽登场、城市攻防、科幻调查',
  },
  {
    id: 'keita_amemiya',
    name: '雨宫庆太',
    category: '特摄',
    summary: '以装甲英雄、异形轮廓和做旧金属皮革塑造暗色奇幻世界，运用烟雾、硬质逆光与仪式化对峙',
    scene: '暗黑英雄、魔界怪物、神秘仪式',
  },
  {
    id: 'osamu_kaneda',
    name: '金田治',
    category: '特摄',
    summary: '重视英雄团队的前中后景调度，以车辆、威亚、广角动作和连环实景爆破组织大规模战斗节拍',
    scene: '团队集结、载具追逐、多人决战',
  },
];

export const filterDirectorStylePresets = (
  category: DirectorStyleCategory | string,
): readonly DirectorStylePreset[] => category === '全部'
  ? directorStylePresets
  : directorStylePresets.filter((preset) => preset.category === category);

export const resolveDirectorStylePreset = (id: string): DirectorStylePreset =>
  directorStylePresets.find((preset) => preset.id === id) || directorStylePresets[0];

export const selectDirectorStyleForCategory = (
  currentId: string,
  category: DirectorStyleCategory | string,
): string => {
  const visiblePresets = filterDirectorStylePresets(category);
  return visiblePresets.some((preset) => preset.id === currentId)
    ? currentId
    : visiblePresets[0]?.id || resolveDirectorStylePreset(currentId).id;
};

export const formatDirectorStyleSummary = (preset: DirectorStylePreset): string =>
  `${preset.summary}；适合：${preset.scene}`;
