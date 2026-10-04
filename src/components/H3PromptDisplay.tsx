export interface H3PromptDisplayProps {
  /** The exact H3 string used by copy/export/submit. This component never mutates it. */
  prompt: string;
  language?: 'zh' | 'en';
}

export type H3SectionName =
  | 'subject_definitions'
  | 'summary'
  | 'retention_analysis'
  | 'detailed_description'
  | 'integrated_multimodal_description'
  | 'overall_soundscape'
  | 'non_diegetic_music';

export interface H3Preamble {
  name: 'preamble';
  /** Text before the first official section, commonly first/last-frame reference alignment. */
  body: string;
  start: 0;
  end: number;
}

export interface H3Section {
  name: H3SectionName;
  /** Text after the section heading, including all original whitespace. */
  body: string;
  /** Exact range in the source prompt, including the heading. */
  start: number;
  end: number;
  heading: string;
}

export type H3PromptPart = H3Preamble | H3Section;

const SECTION_NAMES: readonly H3SectionName[] = [
  'subject_definitions',
  'summary',
  'retention_analysis',
  'detailed_description',
  'integrated_multimodal_description',
  'overall_soundscape',
  'non_diegetic_music',
];

/** Match only an official section at the beginning of a physical line. */
const sectionPattern = new RegExp(`^(${SECTION_NAMES.join('|')}):[ \\t]*`, 'gmu');

/** Quoted dialogue and authored <d> blocks are prose, never structure. */
function literalRanges(text: string): Array<{ start: number; end: number }> {
  return [...text.matchAll(/<d>[\s\S]*?(?:<\/d>|$)|“[\s\S]*?”|「[\s\S]*?」|『[\s\S]*?』|"(?:\\.|[^"\\])*"/gu)]
    .map((match) => ({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }));
}

function outsideLiteral(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return !ranges.some((range) => index >= range.start && index < range.end);
}

/**
 * Parse official H3 section boundaries without rewriting the source. The
 * preamble before the first section is returned explicitly instead of being
 * discarded; first/last-frame prompts use that area for reference alignment.
 */
export function parseH3Sections(prompt: string): H3PromptPart[] {
  const ranges = literalRanges(prompt);
  const matches = [...prompt.matchAll(sectionPattern)].filter((match) => outsideLiteral(match.index ?? 0, ranges));
  if (!matches.length) return prompt ? [{ name: 'preamble', body: prompt, start: 0, end: prompt.length }] : [];

  const firstStart = matches[0].index ?? 0;
  const parts: H3PromptPart[] = [];
  if (firstStart > 0) {
    parts.push({ name: 'preamble', body: prompt.slice(0, firstStart), start: 0, end: firstStart });
  }
  matches.forEach((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? prompt.length;
    parts.push({
      name: match[1] as H3SectionName,
      heading: match[0],
      body: prompt.slice(start + match[0].length, end),
      start,
      end,
    });
  });
  return parts;
}

export interface H3Shot {
  marker: string;
  body: string;
  /** Whitespace (or any text before the first line-anchored marker). */
  prefix?: string;
  start: number;
  end: number;
}

/**
 * Split only a description section whose markers start a line. A marker in
 * retention_analysis or inside dialogue remains ordinary text because callers
 * invoke this helper only for the two official per-shot sections and the line
 * anchor prevents mid-sentence matches.
 */
export function splitH3Shots(body: string): H3Shot[] {
  const markerPattern = /^\[Shot[ \t]+\d+\](?:[ \t]+At[ \t]+\d{2}:\d{2}\.\d{3})?/gmu;
  const ranges = literalRanges(body);
  const matches = [...body.matchAll(markerPattern)].filter((match) => outsideLiteral(match.index ?? 0, ranges));
  if (!matches.length) return [];
  const firstStart = matches[0].index ?? 0;
  if (body.slice(0, firstStart).trim()) return [];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? body.length;
    return {
      marker: match[0],
      body: body.slice(start + match[0].length, end),
      ...(index === 0 && firstStart ? { prefix: body.slice(0, firstStart) } : {}),
      start,
      end,
    };
  });
}

export interface H3ReadableField {
  label?: string;
  value: string;
}

/**
 * Presentation-only labels for authored fields. This never changes the
 * source string and deliberately does not infer missing fields.
 */
export function splitH3ReadableFields(text: string): H3ReadableField[] {
  const ranges = literalRanges(text);
  const labels = /(?:^|[;；\r\n])[ \t]*(主体|空间|光影|镜头|台词|对白|声音|音效|环境层|动作层|情绪层|表演|朝向|Subject|Space|Lighting|Camera|Dialogue|Sound|Audio|Performance|Direction)[ \t]*[:：]/gimu;
  const boundaries = [...text.matchAll(labels)].map((match) => {
    const at = match.index ?? 0;
    const labelStart = at + match[0].indexOf(match[1]);
    return { start: labelStart, label: text.slice(labelStart, at + match[0].length) };
  }).filter((match) => outsideLiteral(match.start, ranges));
  if (!boundaries.length) return [{ value: text }];
  const fields: H3ReadableField[] = [];
  if (boundaries[0].start > 0) fields.push({ value: text.slice(0, boundaries[0].start) });
  boundaries.forEach((boundary, index) => fields.push({
    label: boundary.label,
    value: text.slice(boundary.start, boundaries[index + 1]?.start ?? text.length),
  }));
  return fields;
}

/** Render the exact H3 delivery string. Formatting validation happens in the
 * generation pipeline; this view intentionally adds no labels, sections, or
 * alternate representation that could be mistaken for the submitted prompt. */
export function H3PromptDisplay({ prompt }: H3PromptDisplayProps) {
  return (
    <pre className="h3-prompt-original" role="region" aria-label="H3提示词原文" tabIndex={0}>
      {prompt}
    </pre>
  );
}
