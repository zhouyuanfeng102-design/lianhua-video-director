import type { StoryAnalysisResponse } from './services/llm';
import type { StoryAnalysisCharacter, StoryAnalysisLocation, StoryAnalysisProp, StoryVisualConversionSnapshot } from './types';
import { canonicalCharacterVariantName, normalizeCharacterVariantRecord } from './characterVariants';
import { assembleStoryVisualSceneParagraphs, type StoryVisualScene } from './storyVisualAction';

type AnalysisScene = StoryAnalysisResponse['scenes'][number];
type Participant = StoryVisualScene['participants'][number];
type NamedEntity = StoryAnalysisCharacter | StoryAnalysisLocation | StoryAnalysisProp;

const unique = (values: readonly string[]): string[] => [...new Set(values.map((value) => value.trim()).filter(Boolean))];
const names = (entity: NamedEntity): string[] => unique([entity.name || '', ...(entity.aliases || [])]);
const character = (value: string | StoryAnalysisCharacter): StoryAnalysisCharacter => {
  const record = typeof value === 'string' ? { name: value } : { ...value };
  return { ...record, name: canonicalCharacterVariantName(record) };
};
const entity = <T extends NamedEntity>(value: string | T): T => typeof value === 'string' ? { name: value.trim() } as T : { ...value };

const addCandidate = <T extends NamedEntity>(records: T[], incoming: T): void => {
  const incomingNames = new Set(names(incoming));
  const sameIdentity = records.filter((known) => {
    if (incoming.existingEntityId && known.existingEntityId) return known.existingEntityId === incoming.existingEntityId;
    const knownForm = 'formLabel' in known ? known.formLabel || '' : '';
    const incomingForm = 'formLabel' in incoming ? incoming.formLabel || '' : '';
    return knownForm === incomingForm && names(known).some((name) => incomingNames.has(name));
  });
  if (sameIdentity.length !== 1) { records.push(incoming); return; }
  const known = sameIdentity[0];
  for (const key of Object.keys(incoming) as Array<keyof T>) {
    if (known[key] === undefined || known[key] === '') known[key] = incoming[key];
  }
  const aliases = unique([...(known.aliases || []), ...(incoming.aliases || []), incoming.name !== known.name ? incoming.name || '' : '']);
  if (aliases.length) known.aliases = aliases;
  const bindings = [...(known.storyReferenceBindings || [])];
  for (const binding of incoming.storyReferenceBindings || []) {
    if (!bindings.some((item) => item.referenceId === binding.referenceId && item.subjectId === binding.subjectId)) bindings.push(binding);
  }
  if (bindings.length) known.storyReferenceBindings = bindings;
};

/** Reuse explicit identities and exact, unique aliases only. Local scene-person
 * IDs are not project IDs and must never be passed as existingEntityId. */
const matchParticipant = (participant: Participant, records: readonly StoryAnalysisCharacter[]): StoryAnalysisCharacter | undefined => {
  const explicitId = participant.existingEntityId;
  const byId = records.find((record) => record.existingEntityId === (explicitId || participant.id));
  if (byId) return byId;
  const normalized = normalizeCharacterVariantRecord({ name: participant.name });
  const aliases = new Set(unique([canonicalCharacterVariantName(normalized), ...(participant.aliases || [])]));
  const candidates = records.filter((record) => (!explicitId || !record.existingEntityId || record.existingEntityId === explicitId)
    && (record.formLabel || '') === (normalized.formLabel || '')
    && names(record).some((name) => aliases.has(name)));
  return candidates.length === 1 ? candidates[0] : undefined;
};

const matchingLocation = (name: string, records: readonly StoryAnalysisLocation[]): StoryAnalysisLocation | undefined => {
  const exact = records.filter((record) => names(record).includes(name));
  return exact.length === 1 ? exact[0] : undefined;
};

const mergeProps = (scenes: readonly AnalysisScene[]): Array<string | StoryAnalysisProp> => {
  const props: Array<string | StoryAnalysisProp> = [];
  for (const prop of scenes.flatMap((scene) => scene.props || [])) {
    const record = entity(prop);
    if (!props.some((item) => {
      const known = entity(item);
      return record.existingEntityId ? known.existingEntityId === record.existingEntityId : known.name === record.name;
    })) props.push(prop);
  }
  return props;
};

/** The adopted scene record owns its content and cast. Entity analysis supplies
 * dossiers and media links, without rewriting the adopted scene a second time. */
export const applyStoryVisualScenesToAnalysis = (
  analysis: StoryAnalysisResponse, snapshot?: StoryVisualConversionSnapshot,
): StoryAnalysisResponse => {
  const plan = snapshot?.actionPlan;
  if (!snapshot || !plan?.scenes?.length) return analysis;
  const paragraphs = assembleStoryVisualSceneParagraphs(plan, snapshot.paragraphs || []);
  const characters = (analysis.characters || []).map(character);
  const characterCandidates = [...characters];
  for (const raw of analysis.scenes.flatMap((scene) => scene.characters || [])) {
    addCandidate(characterCandidates, character(raw));
  }
  const locations = (analysis.locations || []).map((value) => entity(value));
  const locationCandidates = [...locations];
  for (const scene of analysis.scenes) if (scene.location) addCandidate(locationCandidates, entity(scene.location));
  const scenePersonRecords = new Map<string, StoryAnalysisCharacter>();
  let originalCursor = 0;
  const analysisRanges = analysis.scenes.map((scene) => {
    const start = scene.sourceStart ?? (scene.content ? snapshot.resultText.indexOf(scene.content, originalCursor) : -1);
    const end = scene.sourceEnd ?? (start >= 0 ? start + (scene.content?.length || 0) : -1);
    if (start >= 0) originalCursor = end;
    return { scene, start, end };
  });
  let cursor = 0;
  const scenes = paragraphs.map((paragraph): AnalysisScene => {
    const authored = plan.scenes!.find((scene) => scene.id === paragraph.sceneId);
    const sourceStart = snapshot.resultText.indexOf(paragraph.text, cursor);
    const sourceEnd = sourceStart >= 0 ? sourceStart + paragraph.text.length : -1;
    if (sourceStart >= 0) cursor = sourceEnd;
    const overlapping = sourceStart >= 0 ? analysisRanges.filter(({ start, end }) => start >= 0 && start < sourceEnd && end > sourceStart).map(({ scene }) => scene) : [];
    const corresponding = overlapping.length ? overlapping : analysis.scenes.filter((scene) => Boolean(authored?.title) && scene.title === authored!.title);
    const sceneCharacters: StoryAnalysisCharacter[] = [];
    for (const participant of authored?.participants || []) {
      if (participant.presence === 'mentioned') continue;
      const known = matchParticipant(participant, characterCandidates) || scenePersonRecords.get(participant.id);
      const name = known?.name || canonicalCharacterVariantName(participant.name);
      const aliases = unique([...(known?.aliases || []), ...(participant.aliases || []), participant.name !== name ? participant.name : '']);
      const record: StoryAnalysisCharacter = {
        ...known, name,
        ...(participant.existingEntityId ? { existingEntityId: participant.existingEntityId } : {}),
        ...(aliases.length ? { aliases } : {}),
      };
      scenePersonRecords.set(participant.id, record);
      const knownIndex = known ? characters.indexOf(known) : -1;
      const rootIndex = knownIndex >= 0 ? knownIndex : characters.findIndex((item) => record.existingEntityId
        ? item.existingEntityId === record.existingEntityId : item.name === record.name);
      if (rootIndex >= 0) characters[rootIndex] = record;
      else characters.push(record);
      const candidateIndex = known ? characterCandidates.indexOf(known) : -1;
      if (candidateIndex >= 0) characterCandidates[candidateIndex] = record;
      else characterCandidates.push(record);
      if (!sceneCharacters.some((item) => record.existingEntityId ? item.existingEntityId === record.existingEntityId : item.name === name)) sceneCharacters.push(record);
    }
    const locationName = authored?.location.trim();
    const location = locationName ? matchingLocation(locationName, locationCandidates) || { name: locationName } : undefined;
    if (location && !locations.some((item) => location.existingEntityId ? item.existingEntityId === location.existingEntityId : item.name === location.name)) locations.push(location);
    const referenceAssetIds = unique(corresponding.flatMap((scene) => scene.referenceAssetIds || []));
    return {
      title: authored?.title || '未分场剧情', content: paragraph.text,
      summary: authored?.title || '', characters: sceneCharacters, location,
      props: mergeProps(corresponding),
      ...(referenceAssetIds.length ? { referenceAssetIds } : {}),
      ...(sourceStart >= 0 ? { sourceStart, sourceEnd } : {}),
    };
  });
  return { ...analysis, characters, locations, scenes };
};
