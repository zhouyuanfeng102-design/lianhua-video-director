/** H3 section layout only. No model calls, content checks or inferred roles. */
export const H3_EXISTING_SOUND_SUMMARY_ZH = '仅呈现上述镜头中已经明确描述的剧情内声音，随对应事件发生与结束；事件间隙保持安静，不添加持续底噪。';
export const H3_EXISTING_SOUND_SUMMARY_EN = 'Only the diegetic sounds already described in the shots are audible, beginning and ending with their corresponding events. Gaps remain quiet, with no added continuous background noise.';

export type H3DeliveryMode = 'integrated' | 'full-reference';
export interface H3DeliverySections {
  body: string;
  subjectDefinitions?: string;
  summary?: string;
  retentionAnalysis?: string;
  overallSoundscape?: string;
  nonDiegeticMusic?: string;
}
export interface H3SectionLayoutOptions {
  mode?: H3DeliveryMode;
  language?: 'zh' | 'en';
  audioMode?: string;
  /** Only explicit sections from the saved draft; never mine narrative prose. */
  preservedAudioPrompt?: string;
}

const integratedNames = ['integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music'];
const referenceNames = ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'];
const sectionPattern = /^(subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music)[\t ]*[:：][\t ]*/gmu;

const readSections = (prompt: string) => {
  const matches = [...prompt.matchAll(sectionPattern)];
  return {
    prefix: prompt.slice(0, matches[0]?.index ?? prompt.length).trim(),
    sections: matches.map((match, index) => ({ name: match[1],
      value: prompt.slice(match.index! + match[0].length, matches[index + 1]?.index ?? prompt.length).trim() })),
  };
};

/** Serialize adopted fields. Missing ambience describes only existing sounds;
 * it does not introduce a bed or suppress authored speech/spot effects. */
export const renderH3DeliverySections = (fields: H3DeliverySections, options: H3SectionLayoutOptions = {}): string => {
  const en = options.language === 'en';
  const silent = options.audioMode === 'none';
  const soundscape = fields.overallSoundscape?.trim() || (silent ? 'N/A'
    : en ? H3_EXISTING_SOUND_SUMMARY_EN : H3_EXISTING_SOUND_SUMMARY_ZH);
  const music = fields.nonDiegeticMusic?.trim() || 'N/A';
  const audio = `overall_soundscape:\n${soundscape}\n\nnon_diegetic_music:\n${music}`;
  if (options.mode !== 'full-reference') return `integrated_multimodal_description:\n${fields.body}\n\n${audio}`;
  // A legacy body may already contain its identity anchors. Do not duplicate
  // those anchors or invent Subject/Picture mappings to fill these sections.
  const definitions = fields.subjectDefinitions?.trim() || (en
    ? 'Use the character and reference identities already stated in the description.' : '人物与参考身份沿用下方正文中的已有说明。');
  const summary = fields.summary?.trim() || (en ? 'The adopted scene unfolds in the following shots.' : '按下方已采用的镜头正文展开场面。');
  const retention = fields.retentionAnalysis?.trim() || (en
    ? 'Retain the identities and reference relationships already stated in the description.' : '保留下方正文中已有的身份与参考关系。');
  return `subject_definitions:\n${definitions}\n\nsummary:\n${summary}\n\nretention_analysis:\n${retention}\n\ndetailed_description:\n${fields.body}\n\n${audio}`;
};

/** Explicit H3 deliveries only. Wrap legacy prose without changing actions,
 * words, timing or identity metadata. This is formatting, not a repair gate. */
export const serializeAuthoredH3Prompt = (prompt: string, options: H3SectionLayoutOptions = {}): string => {
  const { prefix, sections } = readSections(prompt);
  const mode = options.mode || (sections.some((section) => section.name === 'subject_definitions' || section.name === 'detailed_description')
    ? 'full-reference' : 'integrated');
  const names = mode === 'full-reference' ? referenceNames : integratedNames;
  // Keep completed saved text byte-for-byte, including keyframe preambles.
  if (sections.length === names.length && sections.every((section, index) => section.name === names[index] && section.value)) return prompt;
  const value = (name: string): string => sections.filter((section) => section.name === name).map((section) => section.value).filter(Boolean).join('\n\n');
  const saved = options.preservedAudioPrompt ? readSections(options.preservedAudioPrompt).sections : [];
  const audio = (name: string): string => value(name) || saved.filter((section) => section.name === name).map((section) => section.value).filter(Boolean).join('\n\n');
  const body = [prefix, ...(mode === 'integrated' ? sections.filter((section) => ['subject_definitions', 'summary', 'retention_analysis'].includes(section.name)).map((section) => section.value) : []),
    ...sections.filter((section) => ['integrated_multimodal_description', 'detailed_description'].includes(section.name)).map((section) => section.value)].filter(Boolean).join('\n\n');
  return renderH3DeliverySections({ body, subjectDefinitions: value('subject_definitions'), summary: value('summary'), retentionAnalysis: value('retention_analysis'),
    overallSoundscape: audio('overall_soundscape'), nonDiegeticMusic: audio('non_diegetic_music') }, { ...options, mode });
};
