import type { Storyboard } from './types';
import { readH3PromptProtocol } from './h3PromptProtocol';
import { officialH3CanonicalSourceMatches } from './officialH3SourceIdentity';

/** Read literal delivery text, never rebuild its staging from an older timeline.
 * Quoted labels and dialogue are payload, not shot/section delimiters. This is
 * only a convenience excerpt; invalid or canonically stale H3 uses the legacy
 * source. Canonical alignment is not a full project-context freshness verdict:
 * callers still provide current identity details separately for the AI. */
export const readStoryboardImageH3Source = (storyboard: Readonly<Storyboard>): {
  shots: string[];
  subjectDefinitions: string;
  visualPreamble: string;
} | undefined => {
  const prompt = storyboard.officialPromptZh?.trim();
  if (!prompt || (storyboard.officialPromptSource && !officialH3CanonicalSourceMatches(storyboard))) return undefined;
  const protocol = readH3PromptProtocol(prompt);
  if (!protocol || protocol.shots.length !== storyboard.shots.length) return undefined;
  if (protocol.shots.some((shot, index) => {
    const cut = shot.cut?.match(/^At (\d{2}):([0-5]\d)\.(\d{3})$/u);
    const startSec = cut ? Number(cut[1]) * 60 + Number(cut[2]) + Number(cut[3]) / 1000 : 0;
    return Math.abs(startSec - storyboard.shots[index].startSec) > 0.02;
  })) return undefined;
  // Preserve string offsets while excluding syntax-like text inside literals.
  const structuralText = prompt.replace(
    /<d>[\s\S]*?<\/d>|"(?:\\.|[^"\\])*"|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』/gu,
    (literal) => literal.replace(/[^\r\n]/g, ' '),
  );
  const sections = [...structuralText.matchAll(/^(subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music):/gmu)];
  if (sections.length !== protocol.sections.length
    || sections.some((section, index) => section[1] !== protocol.sections[index])) return undefined;
  const sectionBody = (name: string): { text: string; structure: string } | undefined => {
    const index = sections.findIndex((section) => section[1] === name);
    if (index < 0) return undefined;
    const start = sections[index].index + sections[index][0].length;
    const end = sections[index + 1]?.index ?? prompt.length;
    return { text: prompt.slice(start, end), structure: structuralText.slice(start, end) };
  };
  const description = sectionBody('detailed_description') || sectionBody('integrated_multimodal_description');
  if (!description) return undefined;
  const markers = [...description.structure.matchAll(/\[Shot[ \t]*(\d+)\]/gu)];
  if (markers.length !== protocol.shots.length
    || markers.some((marker, index) => marker[0] !== protocol.shots[index].marker)) return undefined;
  return {
    shots: markers.map((marker, index) => description.text.slice(marker.index, markers[index + 1]?.index ?? description.text.length).trim()),
    subjectDefinitions: sectionBody('subject_definitions')?.text.trim() || '',
    visualPreamble: description.text.slice(0, markers[0].index).trim(),
  };
};
