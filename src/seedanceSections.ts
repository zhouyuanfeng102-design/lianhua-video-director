import { maskVideoPictureReferenceLiterals } from './videoPictureReferences';

export type SeedanceSectionName = 'specification' | 'references' | 'subjects' | 'summary' | 'timeline' | 'constraints';
export interface SeedanceSection { start: number; end: number; inline: boolean }
export interface SeedanceSections {
  language: 'zh' | 'en';
  sections: Record<SeedanceSectionName, SeedanceSection>;
}

/** Locate all six unique, ordered headings. Quoted text and dialogue cannot
 * become headings; body coordinates retain the original UTF-16 offsets. */
export const readSeedanceSections = (prompt: string): SeedanceSections | undefined => {
  const masked = maskVideoPictureReferenceLiterals(prompt);
  const names: SeedanceSectionName[] = ['specification', 'references', 'subjects', 'summary', 'timeline', 'constraints'];
  const titleSets = [
    ['视频规格', '参考素材与职责', '主体连续性', '一句话概述', '连续时间轴', '全局约束'],
    ['Video (?:specifications?|specs?)', '(?:References?|Reference materials?|Reference assets?) and responsibilities', '(?:Subject|Character) continuity', '(?:One[- ]sentence summary|Summary)', 'Continuous timeline', 'Global constraints'],
  ];
  for (const [languageIndex, titles] of titleSets.entries()) {
    const matches = titles.map((title) => {
      const label = `(?:${title})(?:[ \\t]*[（(][^\\r\\n）)]*[）)])?`;
      const heading = `(?:\\*\\*${label}[ \\t]*[:：][ \\t]*\\*\\*[ \\t]*|(?:\\*\\*${label}\\*\\*|${label})[ \\t]*(?:[:：][ \\t]*|(?=\\r?$)))`;
      return [...masked.matchAll(new RegExp(`^[ \\t]*(?:#{1,6}[ \\t]+)?${heading}`, 'gimu'))];
    });
    if (matches.some((entries) => entries.length !== 1)) continue;
    const positions = matches.map((entries) => entries[0].index!);
    if (positions.some((position, index) => index > 0 && position <= positions[index - 1])) continue;
    const sections = {} as Record<SeedanceSectionName, SeedanceSection>;
    names.forEach((name, index) => {
      const heading = matches[index][0];
      let start = heading.index! + heading[0].length;
      const inline = prompt[start] !== '\r' && prompt[start] !== '\n';
      if (prompt[start] === '\r') start += 1;
      if (prompt[start] === '\n') start += 1;
      sections[name] = { start, end: positions[index + 1] ?? prompt.length, inline };
    });
    return { language: languageIndex ? 'en' : 'zh', sections };
  }
  return undefined;
};
