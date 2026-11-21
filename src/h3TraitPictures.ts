import { maskVideoPictureReferenceLiterals } from './videoPictureReferences';

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
    stayEn: 'The architecture and fixed furnishings retain their positions, materials, structure and scale relative to the people. People appear where the shot places them. Figures already depicted in the plate remain part of the setting. The shot keeps its written framing.',
    stayZh: '建筑与固定陈设保持原有位置、材料、结构和相对人物的尺度。人物出现在本镜写明的位置。参考图中原有的人像保留为场景的一部分。本镜保持正文写明的取景。',
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
  retention: (subject: string, shotIndexes?: readonly number[]) => string;
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
    retention: (subject, shotIndexes) => {
      const shots = (role === 'scene' ? shotIndexes || [] : [1]).map((index) => `[Shot ${index}]`).join(en ? ', ' : '、');
      const scope = shots ? (en ? ` (appears in ${shots})` : `（出现在 ${shots}）`) : '';
      return en ? `${subject}${scope}: ${trait.marker} - ${duty}. ${stay}` : `${subject}${scope}：${trait.marker} - ${duty}。${stay}`;
    },
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

/** Offsets exclude headings, sound, dialogue and quoted examples. Plain legacy shot bodies have no section envelope. */
export const h3ReferenceProseRanges = (prompt: string) => {
  const masked = maskVideoPictureReferenceLiterals(prompt);
  const description = /^(?:integrated_multimodal_description|detailed_description):/mu.exec(masked);
  const sectionStart = description ? description.index + description[0].length : 0;
  const nextSection = /^(?:overall_soundscape|non_diegetic_music):/mu.exec(masked.slice(sectionStart));
  const sectionEnd = nextSection ? sectionStart + nextSection.index : prompt.length;
  const markers = [...masked.slice(sectionStart, sectionEnd).matchAll(/\[Shot[ \t]*([1-9]\d*)\]/gu)];
  const shots = markers.map((marker, index) => ({
    index: Number(marker[1]), start: sectionStart + marker.index!, bodyStart: sectionStart + marker.index! + marker[0].length,
    end: sectionStart + (markers[index + 1]?.index ?? sectionEnd - sectionStart),
  }));
  return { masked, sectionStart, shots };
};

export interface H3PictureUse {
  number: number;
  role: string;
  text?: string;
  shotIndexes?: readonly number[];
}

const sceneSubject = (definitions: string, number: number): string | undefined => {
  const pattern = new RegExp(`^[ \\t]*(<Subject\\s+\\d+>)[^\\r\\n]*?<Picture\\s+${number}>`, 'gmu');
  const matches = [...definitions.matchAll(pattern)];
  return matches.length === 1 ? matches[0][1] : undefined;
};

/** Keep individually authored duties. Older request-local exports can contain the former generated first-shot sentence. */
export const renderH3SceneReferenceRetention = (source: string, definitions: string, uses: readonly H3PictureUse[] | undefined, en: boolean): string => {
  const scenes = uses?.filter((use) => use.role === 'scene');
  if (!scenes?.length) return source;
  const lines = source.trim() ? source.trim().split(/\r?\n/u) : [];
  const declarations = maskVideoPictureReferenceLiterals(definitions);
  const trait = h3TraitPictureLines('scene', en)!;
  for (const use of scenes) {
    const subject = sceneSubject(declarations, use.number);
    if (!subject) continue;
    const at = lines.findIndex((line) => line.trimStart().startsWith(subject));
    const line = trait.retention(subject, use.shotIndexes);
    if (at < 0) { lines.push(line); continue; }
    const existing = lines[at];
    const generated = en ? existing.includes(`partially_preserved - ${traits.scene.dutyEn}. ${traits.scene.stayEn}`)
      || existing.includes('partially_preserved - architecture, fixed furnishings, and light only. People appear where the shot places them. Furnishings remain in their own material and structure.')
      : existing.includes(`partially_preserved - ${traits.scene.dutyZh}。${traits.scene.stayZh}`)
        || existing.includes('partially_preserved - 只保留建筑、固定陈设和光线。人物出现在本镜写明的位置。陈设留下自己的材料和结构，尺寸跟着这一镜里的人。');
    if (generated) {
      lines[at] = line;
    } else if (use.shotIndexes?.length) {
      // A custom retention entry owns its wording. Synchronize only the official appearance prefix.
      const scopePrefix = /^(\s*<Subject\s+\d+>)(?:\s*\((?:appears in\s+\[Shot\s+\d+\])(?:\s*,\s*\[Shot\s+\d+\])*\)|\s*（出现在\s*\[Shot\s+\d+\](?:\s*[、，,]\s*\[Shot\s+\d+\])*）)?(?=\s*[:：]\s*(?:partially_preserved|fully_preserved|attribute_transfer|weak_reference)\b)/u;
      const scope = line.slice(subject.length).split(/[:：]/u, 1)[0];
      lines[at] = existing.replace(scopePrefix, (_prefix, label: string) => label + scope);
    }
  }
  return lines.join('\n');
};

/** Point each situated shot to its declared space, keeping its cut time attached to the shot marker. */
export const renderH3SceneReferenceShots = (body: string, definitions: string, uses: readonly H3PictureUse[] = [], en: boolean): string => {
  const scenes = uses.filter((use) => use.role === 'scene' && use.shotIndexes?.length);
  if (!scenes.length) return body;
  const declarations = maskVideoPictureReferenceLiterals(definitions);
  const references = scenes.map((use) => ({ shots: use.shotIndexes!, token: sceneSubject(declarations, use.number) || `<Picture ${use.number}>` }));
  const { masked, shots } = h3ReferenceProseRanges(body);
  for (const shot of shots.reverse()) {
    const content = masked.slice(shot.bodyStart, shot.end);
    const tokens = [...new Set(references.filter((ref) => ref.shots.includes(shot.index) && !content.includes(ref.token)).map((ref) => ref.token))];
    if (!tokens.length) continue;
    const at = shot.bodyStart + (/^[ \t]+At[ \t]+\d{2}:\d{2}\.\d+/u.exec(content)?.[0].length || 0);
    const sentence = en ? `The fixed layout of ${tokens.join(' and ')} remains in place.` : `本镜沿用${tokens.join('与')}的固定布局。`;
    body = `${body.slice(0, at)}\n${sentence}\n${body.slice(at).trimStart()}`;
  }
  return body;
};
