import {
  getMorphologyPromptLocks,
  resolveCharacterMorphology,
  type ResolvedCharacterMorphology,
} from './characterMorphology';
import type { PromptReferenceInput, PromptSubjectDefinitionInput } from './promptAdapters';

const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
// The generated image anchor normalizes whitespace, while the project bible
// may retain line breaks. Do not discard punctuation or other authored facts.
const comparableFact = (value: unknown): string => clean(value).replace(/\s+/gu, ' ').replace(/;/gu, '；');

/**
 * Labels emitted by the storyboard-image identity snapshot.  Keep this list
 * deliberately explicit: the budgeter is allowed to shorten a line only
 * after every authored field has been parsed and proven against the semantic
 * subject definition.  A label that is not listed here therefore remains an
 * opaque part of the preceding value and prevents an unsafe shortening.
 *
 * `positiveLocks`/`negativeLocks` are derived fields (they are not persisted
 * on PromptSubjectDefinitionInput).  They are checked against the same
 * morphology resolver that produced the snapshot, rather than treated as
 * arbitrary prose.
 */
const identityFieldKeys = {
  性别: 'gender',
  '种族/物种': 'race',
  物种形态: 'morphology',
  外貌形态: 'morphology',
  身体结构: 'bodyPlan',
  '物种结构正向锁': 'positiveLocks',
  '物种结构防漂移': 'negativeLocks',
  外观: 'appearance',
  服装: 'outfit',
  '默认衣橱/身份服装基底': 'outfit',
  固定道具: 'anchor',
  连续性锚点: 'anchor',
} as const;

type IdentityFieldKey = typeof identityFieldKeys[keyof typeof identityFieldKeys];

const identityFieldPattern = /(?:^|[；;])\s*(性别|种族\/物种|物种形态|外貌形态|身体结构|物种结构正向锁|物种结构防漂移|外观|服装|默认衣橱\/身份服装基底|固定道具|连续性锚点)\s*[：:]\s*/gu;

/** Only the application-generated composition snapshot has the known identity
 * template. User uploads, entity portraits, motion references and keyframes
 * can carry unique instructions and must not be treated as duplicate data. */
const isGeneratedCompositionSnapshot = (reference: PromptReferenceInput): boolean => (
  reference.source === 'generated'
  && clean(reference.referenceRole || reference.role) === 'composition'
  && (!reference.mediaType || reference.mediaType === 'image')
  && !['audio', 'video', 'clay-render'].includes(clean(reference.type))
  && !reference.firstFrame && !reference.lastFrame
  && reference.type !== 'first-frame' && reference.type !== 'last-frame'
  && Boolean(clean(reference.sourceStoryboardId) && clean(reference.sourceShotId))
  && !clean(reference.sourceEntityId)
);

const fieldContainsFact = (field: unknown, fact: string): boolean => {
  const covered = comparableFact(field);
  const expected = comparableFact(fact);
  // appearance may be `apparentAge；appearance`, and anchor contains both
  // `anchor；signatureProps`. Require complete semicolon-bounded values, not a
  // loose substring match (e.g. “男” must not count as covered by “非男”).
  return Boolean(expected) && `；${covered}；`.includes(`；${expected}；`);
};

/**
 * Derived morphology fields are generated from the same resolver at render
 * time and are not free-form project fields.  Match those values exactly
 * (after the harmless whitespace/semicolon normalization above) so a line
 * containing a contradictory body-plan lock can never be shortened merely
 * because it happens to contain one familiar word.
 */
const exactFactMatches = (actual: unknown, expected: unknown): boolean => {
  const left = comparableFact(actual);
  const right = comparableFact(expected);
  return Boolean(left) && Boolean(right) && left === right;
};

const uniqueFacts = (values: readonly unknown[]): string[] => Array.from(new Set(
  values.map(clean).filter(Boolean),
));

interface GeneratedCharacterIdentity {
  indent: string;
  name: string;
  fieldsText: string;
}

interface ResolvedIdentityFacts {
  morphology: ResolvedCharacterMorphology;
  gender: string[];
  race: string[];
  appearance: string[];
  outfit: string[];
  anchor: string[];
  morphologyFacts: string[];
  bodyPlanFacts: string[];
  positiveLockFacts: string[];
  negativeLockFacts: string[];
}

const resolvedIdentityFacts = (definition: PromptSubjectDefinitionInput): ResolvedIdentityFacts => {
  // The resolver intentionally accepts legacy/descriptive morphology values;
  // feeding every available identity field keeps imported projects compatible
  // while still deriving one deterministic set of structural locks.
  const morphology = resolveCharacterMorphology({
    morphology: definition.morphology,
    bodyPlan: definition.bodyPlan,
    race: definition.race,
    appearance: definition.appearance,
    anchor: definition.anchor,
    motion: definition.motion,
    description: definition.description,
  });
  const locks = getMorphologyPromptLocks(morphology);
  const rawMorphology = clean(definition.morphology);
  const morphologyFacts = uniqueFacts([
    // New snapshots use `summary` (for example “真实怪物/异种：六足…”).
    morphology.summary,
    // Older snapshots may have stored the canonical kind or display label.
    rawMorphology,
    morphology.kind,
    morphology.label,
    `${morphology.label}：${morphology.bodyPlan}`,
  ]);
  const bodyPlanFacts = uniqueFacts([
    definition.bodyPlan,
    morphology.bodyPlan,
  ]);
  return {
    morphology,
    gender: uniqueFacts([definition.gender]),
    race: uniqueFacts([definition.race]),
    appearance: uniqueFacts([definition.appearance]),
    outfit: uniqueFacts([definition.outfit]),
    anchor: uniqueFacts([definition.anchor]),
    morphologyFacts,
    bodyPlanFacts,
    positiveLockFacts: uniqueFacts([locks.positiveText, locks.positiveLocks]),
    negativeLockFacts: uniqueFacts([locks.negativeText, locks.negativeLocks]),
  };
};

const parseGeneratedCharacterIdentity = (line: string): GeneratedCharacterIdentity | undefined => {
  const identity = line.match(/^(\s*)人物(?:“([^”]+)”|"([^"]+)")固定身份与外貌\s*[：:]\s*(.*)$/u);
  return identity ? { indent: identity[1], name: identity[2] || identity[3], fieldsText: identity[4] } : undefined;
};

const coveredCharacterDefinition = (
  identity: GeneratedCharacterIdentity,
  subjectDefinitions: readonly PromptSubjectDefinitionInput[],
): PromptSubjectDefinitionInput | undefined => {
  const matches = subjectDefinitions.filter((definition) => (
    clean(definition.name) === identity.name
  ));
  // Ambiguous names must keep their original facts rather than point at an
  // arbitrary duplicate semantic subject.
  if (matches.length !== 1 || matches[0].kind !== 'character') return undefined;
  const definition = matches[0];
  const derived = resolvedIdentityFacts(definition);
  const { fieldsText } = identity;
  const fields = [...fieldsText.matchAll(identityFieldPattern)];
  if (!fields.length || fields[0].index !== 0) return undefined;
  const seen = new Set<string>();
  const seenKeys = new Set<IdentityFieldKey>();
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const label = field[1] as keyof typeof identityFieldKeys;
    const key = identityFieldKeys[label] as IdentityFieldKey | undefined;
    // Keep the historical distinction between `固定道具` and
    // `连续性锚点`: both are intentionally checked against the combined
    // anchor field and may coexist on one identity line.  Other aliases map
    // to one canonical slot and must not appear twice with potentially
    // contradictory values.
    const sharedAnchorAlias = key === 'anchor'
      && (label === '固定道具' || label === '连续性锚点');
    if (!key || seen.has(label) || (seenKeys.has(key) && !sharedAnchorAlias)) return undefined;
    seen.add(label);
    seenKeys.add(key);
    const value = fieldsText.slice(field.index! + field[0].length, fields[index + 1]?.index).trim();
    // An unknown trailing annotation is part of this value and will fail
    // coverage, keeping the entire identity line losslessly intact.
    if (key === 'morphology') {
      if (!derived.morphologyFacts.some((fact) => exactFactMatches(value, fact))) return undefined;
      continue;
    }
    if (key === 'bodyPlan') {
      if (!derived.bodyPlanFacts.some((fact) => exactFactMatches(value, fact))) return undefined;
      continue;
    }
    if (key === 'positiveLocks') {
      if (!derived.positiveLockFacts.some((fact) => exactFactMatches(value, fact))) return undefined;
      continue;
    }
    if (key === 'negativeLocks') {
      if (!derived.negativeLockFacts.some((fact) => exactFactMatches(value, fact))) return undefined;
      continue;
    }
    const standardFacts = derived[key] as string[];
    if (!standardFacts.some((fact) => fieldContainsFact(fact, value))) return undefined;
  }
  return definition;
};

const compactCoveredIdentityLine = (
  line: string,
  subjectDefinitions: readonly PromptSubjectDefinitionInput[],
): string => {
  const identity = parseGeneratedCharacterIdentity(line);
  if (!identity || !coveredCharacterDefinition(identity, subjectDefinitions)) return line;
  // Names, not numbered Subject tokens, keep the derived reference valid for
  // callers using integrated/keyframe output as well as full-reference H3.
  return `${identity.indent}人物“${identity.name}”固定身份与外貌：沿用同名主体定义。`;
};

/** Reuse semantic characters across every selected generated composition in
 * which their complete stored identity is proven. Run before responsibility
 * budgeting: the full source template is the evidence, never the picture's
 * title or mere occurrence of a person's name. Existing explicit bindings
 * keep priority and ordering, and no locations/props are inferred here. */
export const bindVerifiedGeneratedH3CharacterReferences = (
  subjectDefinitions: readonly PromptSubjectDefinitionInput[],
  references: readonly PromptReferenceInput[],
): PromptSubjectDefinitionInput[] => {
  const additions = new Map<PromptSubjectDefinitionInput, string[]>();
  for (const reference of references) {
    const id = clean(reference.id);
    if (!id || !isGeneratedCompositionSnapshot(reference)) continue;
    const identitiesByName = new Map<string, GeneratedCharacterIdentity[]>();
    const anchor = clean(reference.responsibility) || clean(reference.visualAnchor);
    for (const line of anchor.split(/\r?\n/u)) {
      const identity = parseGeneratedCharacterIdentity(line);
      if (!identity) continue;
      const identities = identitiesByName.get(identity.name) || [];
      identities.push(identity);
      identitiesByName.set(identity.name, identities);
    }
    for (const identities of identitiesByName.values()) {
      const definition = coveredCharacterDefinition(identities[0], subjectDefinitions);
      // A second contradictory identity row in the same asset invalidates
      // this inferred link; a matching first row cannot mask that conflict.
      if (!definition || identities.some((identity) => coveredCharacterDefinition(identity, subjectDefinitions) !== definition)) continue;
      const ids = additions.get(definition) || [];
      if (!(definition.referenceAssetIds || []).includes(id) && !ids.includes(id)) ids.push(id);
      additions.set(definition, ids);
    }
  }
  return subjectDefinitions.map((definition) => {
    const ids = additions.get(definition);
    return ids?.length ? { ...definition, referenceAssetIds: [...(definition.referenceAssetIds || []), ...ids] } : definition;
  });
};

/** Reduce only provable template duplication after the full semantic subject
 * definitions have been built. This is a derived compiler view: asset ids,
 * order, pixel sources, raw visualAnchor and all authored state stay intact. */
export const buildBudgetedOfficialH3References = (
  references: readonly PromptReferenceInput[],
  subjectDefinitions: readonly PromptSubjectDefinitionInput[],
): PromptReferenceInput[] => references.map((reference) => {
  if (!isGeneratedCompositionSnapshot(reference) || !clean(reference.responsibility)) return reference;
  let hasSourceShotState = false;
  const lines = reference.responsibility!.split(/(\r?\n)/u).map((line) => {
    if (/^\r?\n$/u.test(line)) return line;
    const compacted = compactCoveredIdentityLine(line, subjectDefinitions);
    // Generated snapshots describe a previous image's moment. Preserve its
    // complete unique spatial/action evidence, but never request replay of the
    // source segment in the new segment's video.
    const sourceState = compacted.match(/^(\s*)本镜(画面主体与站位|可见动作|可见结果)(\s*[：:][\s\S]*)$/u);
    if (!sourceState) return compacted;
    hasSourceShotState = true;
    return `${sourceState[1]}来源图${sourceState[2]}${sourceState[3]}`;
  });
  const scoped = lines.join('');
  const responsibility = hasSourceShotState
    ? `来源图仅作静态构图与外观参考；本段动作与结果以当前 Shots 为准，不重演来源镜头。\n${scoped}`
    : scoped;
  return responsibility === reference.responsibility ? reference : { ...reference, responsibility };
});
