import { characterVariantAliases, characterVariantBaseName, characterVariantDisplayName } from './characterVariants';
import { sourceContentHash } from './sourceContentHash';
import type { Character, CharacterPresence, H3IdentityBindings, PromptCharacterParticipation, PromptCharacterParticipationSnapshot, Storyboard } from './types';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const unique = <T,>(values: readonly T[]): T[] => [...new Set(values)];
type CharacterIdentitySource = Pick<Character, 'id' | 'name'> & Partial<Pick<Character,
  'aliases' | 'baseName' | 'formLabel' | 'variantOf' | 'transformationType' | 'dossier'>>;
const active = <T extends CharacterIdentitySource>(characters: readonly T[]): T[] => characters.filter((character) => !character.dossier?.archivedIntoCharacterId);
const rawAliases = (character: CharacterIdentitySource): string[] => unique([
  character.name, characterVariantDisplayName(character), ...characterVariantAliases(character),
  ...(character.aliases || []), ...(character.dossier?.aliases || []),
  character.baseName || character.variantOf || characterVariantBaseName(character),
  // Some old dossiers use a hyphen for an explicitly named visual form.
  // Ordinary hyphenated names are never split.
  character.name.match(/^(.+?)[-—·•]([^\n]+形态)$/u)?.[1] || '',
  // Legacy novels often use the first named component of a full Chinese
  // fantasy name. Accept only 2+ Han characters; collisions across aliases
  // and visual forms are still rejected by resolveCharacterAlias.
  character.name.match(/^([\p{Script=Han}]{2,})[·•]/u)?.[1] || '',
].map((value) => value.trim()).filter(Boolean));

/** Explicit aliases, named forms and unique Chinese given-name components;
 * collisions are rejected rather than joined by substring/fuzzy matching. */
export const resolveCharacterAlias = <T extends CharacterIdentitySource>(alias: string, characters: readonly T[]): T | undefined => {
  const name = alias.trim();
  if (!name) return undefined;
  const matches = active(characters).filter((character) => rawAliases(character).includes(name));
  return matches.length === 1 ? matches[0] : undefined;
};

export const characterParticipationAliases = (character: CharacterIdentitySource, characters: readonly CharacterIdentitySource[]): string[] => (
  rawAliases(character).filter((alias) => resolveCharacterAlias(alias, characters)?.id === character.id)
);

export const inspectCharacterParticipation = (value: unknown): { value?: PromptCharacterParticipation; issues: string[] } => {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.characters) || value.characters.length > 4096) {
    return { issues: ['characterParticipation必须是version=1且characters为数组的对象。'] };
  }
  const issues: string[] = [];
  const characters: PromptCharacterParticipation['characters'] = [];
  value.characters.forEach((item: unknown, index: number) => {
    if (!record(item) || !['characterId', 'name', 'evidence'].every((key) => typeof item[key] === 'string' && (item[key] as string).trim())
      || !['visible', 'offscreen', 'mentioned'].includes(String(item.presence))
      || !Number.isSafeInteger(item.shotIndex) || (item.shotIndex as number) < 1 || (item.shotIndex as number) > 900
      || (item.speaking !== undefined && typeof item.speaking !== 'boolean')) {
      issues.push(`characterParticipation.characters[${index}]须提供人物ID、原名、参与类型、正整数shotIndex、逐字evidence及可选speaking布尔值。`);
      return;
    }
    characters.push({ characterId: item.characterId as string, name: item.name as string,
      presence: item.presence as CharacterPresence, shotIndex: item.shotIndex as number, evidence: item.evidence as string,
      ...(typeof item.speaking === 'boolean' ? { speaking: item.speaking } : {}),
    });
  });
  return issues.length ? { issues } : { value: { version: 1, characters }, issues };
};

export const normalizeCharacterParticipationSnapshot = (value: unknown): PromptCharacterParticipationSnapshot | undefined => {
  const inspected = inspectCharacterParticipation(value);
  return inspected.value && record(value) && typeof value.promptFingerprint === 'string' && value.promptFingerprint.trim()
    ? { ...inspected.value, promptFingerprint: value.promptFingerprint } : undefined;
};

export const stampCharacterParticipation = (prompt: string, participation: PromptCharacterParticipation): PromptCharacterParticipationSnapshot => ({
  ...participation, characters: participation.characters.map((entry) => ({ ...entry })), promptFingerprint: sourceContentHash(prompt),
});

const promptShots = (prompt: string): Array<{ index: number; text: string }> => {
  const section = /^(?:integrated_multimodal_description|detailed_description):\s*/gmu.exec(prompt);
  const bodyStart = section ? section.index + section[0].length : 0;
  const body = prompt.slice(bodyStart).split(/^(?:overall_soundscape|non_diegetic_music):/mu)[0];
  const markers = [...body.matchAll(/\[Shot\s+([1-9]\d*)\]/gu)];
  return markers.length ? markers.map((match, index) => ({
    index: Number(match[1]), text: body.slice(match.index! + match[0].length, markers[index + 1]?.index),
  })) : [{ index: 1, text: body }];
};

/** Validate only declared evidence/IDs and metadata coverage, never infer the
 * story's required cast or reject an old saved prompt without metadata. */
export const characterParticipationIssues = (
  prompt: string,
  participation: PromptCharacterParticipation,
  characters: readonly { id: string; name: string }[],
  bindings?: H3IdentityBindings,
): string[] => {
  const issues: string[] = [];
  const shots = new Map(promptShots(prompt).map((shot) => [shot.index, shot.text]));
  const keys = new Set<string>();
  for (const entry of participation.characters) {
    const matches = characters.filter((character) => character.id === entry.characterId);
    if (matches.length !== 1 || matches[0].name !== entry.name) issues.push('参与记录的人物ID和原名必须对应本次characterIdentityFacts的唯一记录。');
    if (!shots.get(entry.shotIndex)?.includes(entry.evidence)) issues.push(`第${entry.shotIndex}镜参与证据不在对应H3镜头正文中，不能用原小说、身份档案或别镜文字充当证据。`);
    const key = `${entry.characterId}:${entry.shotIndex}:${entry.presence}`;
    if (keys.has(key)) issues.push(`第${entry.shotIndex}镜同一人物参与类型重复。`);
    keys.add(key);
    if (entry.presence === 'mentioned' && entry.speaking) issues.push('仅被提及人物不能同时标为本镜实际发声。');
    if ((entry.presence === 'visible' || entry.speaking)
      && bindings?.characters.filter((binding) => binding.characterId === entry.characterId).length !== 1) {
      issues.push(`第${entry.shotIndex}镜已声明出镜或发声的人物“${entry.name}”缺少唯一identityBindings记录，请补身份句及绑定，不得改成mentioned来规避。`);
    }
  }
  for (const binding of bindings?.characters || []) {
    if (!participation.characters.some((entry) => entry.characterId === binding.characterId)) {
      issues.push(`identityBindings已声明人物“${binding.name}”，characterParticipation须说明其实际参与类型与对应镜头，不能遗漏参与记录；不要为通过检查强迫其入画。`);
    }
  }
  return unique(issues);
};

export interface ResolvedCharacterParticipation {
  characterId: string;
  name: string;
  presence: CharacterPresence;
  shotIndexes: number[];
  visibleShotIndexes: number[];
  evidence: string[];
  visibleEvidence: string[];
  source: 'metadata' | 'text' | 'identity';
}
export interface CharacterParticipationResult {
  characters: ResolvedCharacterParticipation[];
  ambiguousNames: string[];
  usedFallback: boolean;
}
const rank: Record<CharacterPresence, number> = { mentioned: 0, offscreen: 1, visible: 2 };
const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const namePattern = (name: string): RegExp => /^[\x00-\x7f]+$/u.test(name)
  ? new RegExp(`(?<![A-Za-z0-9])${escaped(name)}(?![A-Za-z0-9])`, 'iu') : new RegExp(escaped(name), 'u');
const offscreenPattern = /画外|镜外|未入镜|不入镜|画面外|off[- ]screen|out of (?:the )?(?:frame|shot)/iu;
const mentionPattern = /提(?:及|到|起)|谈论|想到|想起|回忆|听说|传闻|假如|如果|关于|以为|想象|名为|mention|remember|think(?:s|ing)? (?:about|of)|rumou?r|if\b/iu;
const visualBefore = /(?:可见|看到|看见|远景|近景|特写|画面(?:中|内)|景深(?:处|内)|画幅|入画|站着的|站立的|静立的|visible|in (?:the )?(?:foreground|background|frame)|close[- ]up)[^。！？;；\n]{0,45}$/iu;
const visualAfter = /^[^。！？;；\n]{0,36}(?:站(?:在|立|着)|坐(?:在|着)|静立|伫立|走(?:向|到|出|入)|奔跑|冲(?:向|锋)|挥(?:动|舞|枪|剑)|抬(?:头|手)|转身|面向|身穿|穿着|举(?:起|着)|飞(?:起|出)|跃(?:起|向)|倒(?:下|地)|跪(?:下|地)|后退|俯视|凝视|注视|微笑|皱眉|闭眼|睁眼|握(?:着|住)|抚摸|拥抱|亲吻|入画|出现在画面|stands?\b|standing\b|sits?\b|sitting\b|walks?\b|runs?\b|wears?\b|wearing\b|faces?\b|facing\b|holds?\b|holding\b|raises?\b|turns?\b|strikes?\b|charges?\b|attacks?\b|looks?\b|thrusts?\b|swings?\b|slashes?\b)/iu;

/** Conservative legacy reading for display/request binding only. It never
 * rewrites saved prompts or treats a quoted mention as a visible character. */
export const resolvePromptCharacterParticipation = (
  prompt: string,
  characters: readonly CharacterIdentitySource[],
  options: { participation?: PromptCharacterParticipationSnapshot; identityBindings?: H3IdentityBindings } = {},
): CharacterParticipationResult => {
  const catalog = active(characters);
  const byId = new Map(catalog.map((character) => [character.id, character]));
  const results = new Map<string, ResolvedCharacterParticipation>();
  const add = (id: string, presence: CharacterPresence, shotIndex: number, evidence: string, source: ResolvedCharacterParticipation['source']) => {
    const character = byId.get(id);
    if (!character) return;
    const prior = results.get(id);
    results.set(id, prior ? {
      ...prior, ...(rank[presence] > rank[prior.presence] ? { presence } : {}),
      shotIndexes: unique([...prior.shotIndexes, shotIndex]), evidence: unique([...prior.evidence, evidence]),
      visibleShotIndexes: unique([...prior.visibleShotIndexes, ...(presence === 'visible' ? [shotIndex] : [])]),
      visibleEvidence: unique([...prior.visibleEvidence, ...(presence === 'visible' ? [evidence] : [])]),
    } : { characterId: id, name: character.name, presence, shotIndexes: [shotIndex], evidence: [evidence], source,
      visibleShotIndexes: presence === 'visible' ? [shotIndex] : [], visibleEvidence: presence === 'visible' ? [evidence] : [],
    });
  };
  const saved = normalizeCharacterParticipationSnapshot(options.participation);
  if (saved && saved.promptFingerprint === sourceContentHash(prompt)) {
    for (const entry of saved.characters) add(entry.characterId, entry.presence, entry.shotIndex, entry.evidence, 'metadata');
    return { characters: [...results.values()], ambiguousNames: [], usedFallback: false };
  }
  const ambiguousNames = unique(catalog.flatMap(rawAliases)).filter((alias) => !resolveCharacterAlias(alias, catalog)
    && namePattern(alias).test(prompt));
  for (const shot of promptShots(prompt)) {
    const noAudio = shot.text.replace(/<sound>[\s\S]*?<\/sound>/giu, '');
    const narrative = noAudio.replace(/<d>[\s\S]*?<\/d>/giu, '').replace(/[“「『][\s\S]*?[”」』]|"[^"\n]*"/gu, '');
    // The stored identity is a mapping, not evidence that a later named
    // person is physically visible in the first shot's staging.
    let actionText = narrative;
    for (const entry of options.identityBindings?.characters || []) actionText = actionText.replace(entry.referenceAnchor, '');
    actionText = actionText.replace(/(?:Identity|身份)\s*[:：][^\n。.!?]+[。.!?]?/giu, '');
    for (const character of catalog) {
      for (const alias of characterParticipationAliases(character, catalog)) {
        const pattern = namePattern(alias);
        for (const clause of actionText.split(/(?<=[。！？!?；;])|\n/gu)) {
          const match = pattern.exec(clause);
          if (!match) continue;
          const before = clause.slice(0, match.index);
          const after = clause.slice(match.index + match[0].length);
          if (/(?:假的|假扮的|伪装成的|名叫)\s*$/u.test(before) || /^(?:姐姐|妹妹|哥哥|弟弟|的名字|这个名字)/u.test(after)) continue;
          const nearby = before.slice(-30) + match[0] + after.slice(0, 45);
          const visibleContact = /(?:扑向|冲向|攻击|刺向|斩向)[^。！？;；\n]{0,12}$/u.test(before)
            && /^[，,\s]*被其[^。！？;；\n]{0,16}(?:枪|剑|刀|拳|掌)[^。！？;；\n]{0,12}(?:击|刺|斩|扫|抹|穿|挡)/u.test(after);
          const actionTarget = /(?:扑向|冲向|攻击|刺向|斩向|击中|打中|救下|拉住|拥抱|亲吻)[^。！？;；\n]{0,8}$/u.test(before)
            || /向\s*$/u.test(before) && /^[^。！？;；\n]{0,8}(?:冲锋|攻击|扑去|开火)/u.test(after);
          const presence: CharacterPresence = offscreenPattern.test(nearby) ? 'offscreen'
            : mentionPattern.test(before.slice(-25)) ? 'mentioned'
              : visualBefore.test(before) || visibleContact || !actionTarget && visualAfter.test(after) ? 'visible'
                : actionTarget ? 'offscreen' : 'mentioned';
          add(character.id, presence, shot.index, clause.trim(), 'text');
        }
        // Quotes still establish a mention, never on-screen participation.
        if (!results.has(character.id) && pattern.test(noAudio)) add(character.id, 'mentioned', shot.index, alias, 'text');
      }
    }
  }
  for (const binding of options.identityBindings?.characters || []) {
    if (!results.has(binding.characterId) && prompt.includes(binding.referenceAnchor)) {
      add(binding.characterId, binding.speakerToken ? 'offscreen' : 'mentioned', 1, binding.referenceAnchor, 'identity');
    }
  }
  return { characters: [...results.values()], ambiguousNames, usedFallback: true };
};

/** New AI deliveries must account for unique names actually present in shot
 * prose. This is a coverage check only: the model decides visible/offscreen/
 * mentioned, and a quoted mention never mandates a visual identity binding. */
export const characterParticipationCoverageIssues = (
  prompt: string,
  participation: PromptCharacterParticipation,
  characters: readonly CharacterIdentitySource[],
): string[] => resolvePromptCharacterParticipation(prompt, characters).characters
  .filter((entry) => !participation.characters.some((item) => item.characterId === entry.characterId))
  .map((entry) => `镜头正文出现了可唯一对应人物“${entry.name}”的称呼，characterParticipation缺少该人物记录。请结合最终镜头判断visible/offscreen/mentioned，不为补记录强迫入画，不删除正文称呼来规避。`);

export const resolveStoryboardCharacterParticipation = (
  board: Pick<Storyboard, 'officialPromptZh' | 'officialPromptEn' | 'officialPromptEnSource' | 'h3IdentityBindings' | 'h3IdentityBindingsEn' | 'h3CharacterParticipation'>,
  characters: readonly Character[],
  prompt: string,
): CharacterParticipationResult => {
  const chinese = board.officialPromptZh;
  if (chinese && (prompt === chinese || prompt === board.officialPromptEn && board.officialPromptEnSource === chinese)) {
    return resolvePromptCharacterParticipation(chinese, characters, { participation: board.h3CharacterParticipation, identityBindings: board.h3IdentityBindings });
  }
  return resolvePromptCharacterParticipation(prompt, characters, {
    identityBindings: prompt === board.officialPromptEn ? board.h3IdentityBindingsEn : undefined,
  });
};

export const CHARACTER_PARTICIPATION_RULE = [
  '同步返回characterParticipation:{"version":1,"characters":[{"characterId":"已有ID","name":"对应原名","presence":"visible","shotIndex":1,"evidence":"逐字复制本次H3该镜中实际参与的短句","speaking":false}]}。这不是H3新增section。逐镜阅读全文，登记本段实际出现或被提及的已知人物；同一人物可跨镜重复，同镜同参与类型不重复。',
  'presence由你结合镜头语义判断：visible为真实入画（包括远景、背影、小比例、静默、后镜首次出现）；offscreen为画外行动者或画外发声者；mentioned为对白/回忆/地点方向等只提名字、未实际出场。画面焦点不是完整演员表；不能只登记首镜主角，也不能把所有资料人物塞入画面。evidence须逐字存在于所填shotIndex的H3正文，不能拿人物档案或旧原文冒充出场证据。',
  '先根据characterIdentityFacts的ID、原名、已确认aliases与具体形态确认对应；身份未揭示时仍保持正文原称呼，元数据可关联已知ID。没有唯一依据不得猜ID或合并形态；尚未有资料的人物保留正文原称呼，不伪造ID。speaking只表示本镜实际发声，mentioned不得为true。',
  '所有visible人物以及speaking=true的人物都必须在identityBindings拥有对应唯一记录和纯身份句；远景、静默或稍后才出场不能省略。身份句写在其首次实际需要的镜头内，full-reference可写subject_definitions。offscreen不因有身份档案就改成入画，mentioned无需视觉绑定；不要为了通过检查改写参与类型或删人物。',
  '同一次回答内对照最终H3逐镜自检人物参与和身份绑定是否遗漏、引用错误或把对白提及误当出镜；新正文与这些记录作为一次完整交付同步返回，不增加剧情或另行输出检查报告。',
].join('\n');
