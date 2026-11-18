/** Standalone `<Picture N>` is an H3 composition anchor: a first frame, keyframe,
 * last frame, or an explicit composition/camera plate. Scene, prop, costume
 * and style plates are trait references. They are cited inside `<Subject N>`
 * and kept with a retention marker, so an empty location plate is not treated
 * as the opening composition. */

const compositionRoles = new Set(['first-frame', 'last-frame', 'middle-frame', 'composition', 'camera']);

export const h3CompositionAnchorRole = (role: string): boolean => compositionRoles.has(role);

interface TraitCopy {
  marker: 'partially_preserved' | 'attribute_transfer' | 'weak_reference';
  nameEn: string;
  nameZh: string;
  dutyEn: string;
  dutyZh: string;
  stayEn: string;
  stayZh: string;
}

const traits: Record<string, TraitCopy> = {
  scene: {
    marker: 'partially_preserved',
    nameEn: 'the place', nameZh: '这处空间',
    dutyEn: 'architecture, fixed furnishings, and light only',
    dutyZh: '只保留建筑、固定陈设和光线',
    stayEn: 'People appear where the shot places them. Furnishings remain in their own material and structure. Size follows the people in this shot. A platform edge against a lower back remains about waist high. A mark on a wall or base remains smaller than that person\'s head. This shot keeps its written framing. People already shown in this picture remain part of the setting and are not copied beside a named person.',
    stayZh: '人物出现在本镜写明的位置。陈设留下自己的材料和结构，尺寸跟着这一镜里的人。台沿抵住后腰时，台面留在腰的高度。墙上或台座上的纹样留得比这个人的头小。这一镜保持正文写明的取景。图内已经画着的人只作场面，不在具名人物旁边再复制一个。',
  },
  prop: {
    marker: 'partially_preserved',
    nameEn: 'the prop', nameZh: '这件道具',
    dutyEn: 'the prop\'s shape, material, and color only',
    dutyZh: '只保留这件道具的形状、材料和颜色',
    stayEn: 'The prop remains where the shot places it. The prop keeps its own material, color, and structure. Size follows the people in this shot. A mark that fills its reference picture remains only the drawing of that mark, and remains smaller than the person\'s head when it sits on a wall or base.',
    stayZh: '这件道具留在本镜写明的位置。这件道具留下自己的材料、颜色和结构，尺寸跟着这一镜里的人。铺满参考图的纹样只留下这枚纹样的画法，落在墙上或台座上时比这个人的头小。',
  },
  style: {
    marker: 'attribute_transfer',
    nameEn: 'the picture style', nameZh: '画面风格',
    dutyEn: 'color, material, and texture only',
    dutyZh: '只保留色彩、材料和质感',
    stayEn: 'The shot keeps its written people and placement. People already shown in this picture remain part of the setting and are not copied beside a named person.',
    stayZh: '人物和站位沿用本镜正文。图内已经画着的人只作场面，不在具名人物旁边再复制一个。',
  },
  motion: {
    marker: 'weak_reference',
    nameEn: 'the pose', nameZh: '这一姿态',
    dutyEn: 'one pose',
    dutyZh: '只参考这一姿态',
    stayEn: 'The shot\'s action continues from its written start.',
    stayZh: '本镜动作从正文写的起点继续。',
  },
  'clay-render': {
    marker: 'partially_preserved',
    nameEn: 'the form', nameZh: '这处形体',
    dutyEn: 'form and spatial structure only',
    dutyZh: '只保留形体和空间结构',
    stayEn: 'People appear where the shot places them.',
    stayZh: '人物出现在本镜写明的位置。',
  },
  creative: {
    marker: 'weak_reference',
    nameEn: 'the visual concept', nameZh: '视觉概念',
    dutyEn: 'the visual concept only',
    dutyZh: '只参考视觉概念',
    stayEn: 'The shot keeps its written people and action.',
    stayZh: '人物和动作沿用本镜正文。',
  },
  general: {
    marker: 'weak_reference',
    nameEn: 'the appearance reference', nameZh: '外观参考',
    dutyEn: 'appearance only',
    dutyZh: '只参考外观',
    stayEn: 'People appear where the shot places them. People already shown in this picture remain part of the setting and are not copied beside a named person.',
    stayZh: '人物出现在本镜写明的位置。图内已经画着的人只作场面，不在具名人物旁边再复制一个。',
  },
};

export interface H3TraitPictureLines {
  definition: (subject: string, picture: number) => string;
  retention: (subject: string) => string;
  /** Used only when the prompt has no subject section. It stays inside the
   * existing reference-uses sentence and does not name a composition to copy. */
  inline: (picture: number) => string;
}

export const h3TraitPictureLines = (role: string, en: boolean): H3TraitPictureLines | undefined => {
  const trait = traits[role];
  if (!trait) return undefined;
  const name = en ? trait.nameEn : trait.nameZh;
  const duty = en ? trait.dutyEn : trait.dutyZh;
  const stay = en ? trait.stayEn : trait.stayZh;
  return {
    definition: (subject, picture) => en
      ? `${subject} is ${name}, referenced from <Picture ${picture}>: ${duty}.`
      : `${subject} 是${name}，视觉参考为 <Picture ${picture}>：${duty}。`,
    retention: (subject) => en
      ? `${subject} (appears in [Shot 1]): ${trait.marker} - ${duty}. ${stay}`
      : `${subject}（出现在 [Shot 1]）：${trait.marker} - ${duty}。${stay}`,
    inline: (picture) => {
      const clause = stay.replace(/[.。]$/u, '');
      const continued = en ? clause.charAt(0).toLowerCase() + clause.slice(1) : clause;
      return en
        ? `<Picture ${picture}> ${trait.marker}, ${duty}, ${continued}`
        : `<Picture ${picture}> ${trait.marker}，${duty}，${continued}`;
    },
  };
};

export const h3PictureCitedInSubject = (prompt: string, picture: number): boolean =>
  new RegExp(`<Subject\\s+\\d+>[^\\n]{0,500}<Picture\\s+${picture}>(?![0-9])`, 'u').test(prompt);
