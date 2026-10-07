import type {
  ContinuityReport,
  NsfwBodyAnchors,
  NsfwShotContinuityState,
} from './continuity';
import type { ComfyVideoConfig, VideoApiProfile, VideoGenerationJob, VideoGenerationBackend } from './videoGenerationTypes';
import type { VideoGenerationSource } from './videoGenerationTypes';
import type { RunningHubVideoConfig, RunningHubVideoFieldControl } from './runningHubVideoTypes';
import type {
  ImagePromptAssetKind,
  ImagePromptFormat,
  ImagePromptRulesState,
} from './imagePromptRules';
import type { MorphologyKind } from './characterMorphology';
import type { VideoWorkbenchDraft, VideoWorkbenchState } from './videoWorkbench';
import type { ImageOutputSizePreferences } from './imageOutputSize';
import type { StoryboardImageOutputSizePreference } from './storyboardImageOutputSize';
import type { SequenceDurationEstimateSnapshot } from './storyPacingEstimate';
import type { VideoCreativeDirection } from './videoCreativeDirection';
import type { DirectorLookDraft } from './directorLookDraft';
import type { StoryPacingContext } from './storyPacing';

// Re-export the shared morphology contracts so callers that already import
// project entities from `types.ts` do not need a second type-only import.
export type {
  CharacterMorphologyInput,
  MorphologyConfidence,
  MorphologyFamily,
  MorphologyKind,
  MorphologyPromptLocks,
  MorphologyResolutionOptions,
  MorphologySource,
  ResolvedCharacterMorphology,
} from './characterMorphology';

export type {
  ContinuityIssue,
  ContinuityReport,
  NsfwBodyAnchors,
  NsfwShotContinuityState,
} from './continuity';

export type ViewKey =
  | 'dashboard'
  | 'story'
  | 'director'
  | 'video'
  | 'storyboard'
  | 'image'
  | 'video-workbench'
  | 'assets'
  | 'jobs'
  | 'rules'
  | 'settings';

export type Workflow = 'drama' | 'action' | 'grid';
/** A converter may target one director workflow or every video workflow. */
export type ConverterWorkflow = Workflow | 'all';
export type InputMode = 'text' | 'reference' | 'text_reference';
export type DurationPreset = '5s' | '10s' | '15s' | 'custom';
export type ShotMode = 'auto' | 'exact';
export type Pace = 'slow' | 'standard' | 'tight' | 'fast';
export type SequenceDurationMode = 'ai-estimated' | 'fixed';
export type SequenceSegmentationMode = 'natural' | 'fixed';
export type SequenceFitStatus = 'comfortable' | 'balanced' | 'compressed' | 'insufficient';
export type VideoSegmentStatus = 'planned' | 'generating' | 'ready' | 'stale' | 'failed';

export interface SourceDocument {
  id: string;
  /** A source document is one chapter inside this project. */
  order?: number;
  archived?: boolean;
  volume?: string;
  /** Preserved legacy work whose original chapter cannot be identified. */
  historical?: boolean;
  name: string;
  content: string;
  /** Stable hash of the exact source text used to derive downstream artifacts. */
  contentHash?: string;
  createdAt: number;
  updatedAt: number;
}

/** Stable, editable anatomy slots used only by the adult private-image workflow. */
export type NsfwPrivatePart =
  | 'full-body'
  | 'breasts'
  | 'vulva'
  | 'anus'
  | 'penis'
  | 'scrotum';

export type CharacterNsfwProfileProvenance =
  | 'story-analysis'
  | 'story-enrichment'
  | 'manual'
  | 'vision';

/**
 * Stable visual design for an explicitly adult character. Temporary nudity,
 * contact, arousal, action stages and residue belong to per-shot continuity.
 */
export interface CharacterNsfwProfile {
  fullBody?: string;
  breasts?: string;
  vulva?: string;
  anus?: string;
  penis?: string;
  scrotum?: string;
  provenance?: CharacterNsfwProfileProvenance;
  /** Source/version identity used to replace stale AI-derived profiles safely. */
  sourceHash?: string;
}

export interface Character {
  id: string;
  aliases?: string[];
  sourceChapterIds?: string[];
  baseCharacterId?: string;
  /** User-controlled ordinary dossier provenance; absent means legacy story-aware behavior. */
  dossier?: {
    useStory?: boolean;
    confirmedFields?: string[];
    fieldSources?: Record<string, 'manual' | 'reference' | 'story' | 'custom'>;
    aliases?: string[];
    archivedIntoCharacterId?: string;
    updatedAt?: number;
  };
  name: string;
  /** Stable narrative identity shared by visual forms, when this is a form variant. */
  baseName?: string;
  /** Human-readable form label shown in the asset library (e.g. 原始形态、女性形态). */
  formLabel?: string;
  /** Base character name that this visual form transforms from. */
  variantOf?: string;
  /** Transformation category/fact (gender, appearance, species, body plan, etc.). */
  transformationType?: string;
  gender: string;
  apparentAge: string;
  actualAge?: string;
  height?: string;
  race: string;
  /** Optional visual body-plan category; absent on legacy projects. */
  morphology?: MorphologyKind | string;
  /** Concrete anatomy/structure lock shared by story and image prompts. */
  bodyPlan?: string;
  appearance: string;
  outfit: string;
  signatureProps: string;
  personality: string;
  motionHabits: string;
  anchor: string;
  negativeContinuity: string;
  assetIds: string[];
  /** Optional source-grounded stable body facts; never auto-created. */
  nsfwBodyAnchors?: NsfwBodyAnchors;
  /** Adult-only stable private visual dossier, kept separate from shot state. */
  nsfwProfile?: CharacterNsfwProfile;
}

export interface Location {
  id: string;
  aliases?: string[];
  sourceChapterIds?: string[];
  name: string;
  description: string;
  timeWeather: string;
  lighting: string;
  palette: string;
  fixedProps: string;
  anchor: string;
  /** Saved image style. Absent inherits the director style; empty means no preset. */
  visualStyle?: string;
  assetIds: string[];
}

export interface Prop {
  id: string;
  aliases?: string[];
  sourceChapterIds?: string[];
  name: string;
  category: string;
  material: string;
  appearance: string;
  effect: string;
  stateRules: string;
  assetIds: string[];
}

export type AssetType = 'character' | 'location' | 'prop' | 'grid' | 'reference' | 'first-frame' | 'last-frame' | 'video' | 'audio' | 'clay-render';
export type AssetRole = 'character' | 'scene' | 'prop' | 'grid' | 'style' | 'first-frame' | 'last-frame' | 'motion' | 'audio' | 'composition';
export type ImageVariant = 'portrait' | 'half-body' | 'full-body' | 'five-view' | 'turnaround' | 'reference' | 'landscape' | 'snapshot' | 'first-frame' | 'last-frame' | 'storyboard-frame' | 'icon' | 'close-up' | 'showcase' | 'grid' | 'private-full-body' | 'private-five-view' | 'private-turnaround' | 'private-four-in-one' | 'private-close-up';

/** Media metadata introduced in schema v4. Optional so v1-v3 projects remain readable. */
export type ReferenceMediaType = 'image' | 'video' | 'audio' | 'clay-render';
export type ReferenceRole = 'subject' | 'character' | 'scene' | 'prop' | 'style' | 'motion' | 'composition' | 'camera' | 'first-frame' | 'last-frame' | 'audio' | 'dialogue' | 'clay-render' | 'creative' | 'general' | 'unknown';

export interface AudioCue {
  id: string;
  kind: 'dialogue' | 'ambience' | 'foley' | 'music' | 'voiceover' | 'silence';
  label: string;
  speaker?: string;
  text?: string;
  startSec?: number;
  endSec?: number;
  sourceAssetId?: string;
  notes?: string;
}

/** AI-authored visual identity anchors. They are metadata, never extra H3 sections. */
export interface H3IdentityBindings {
  version: 1;
  characters: Array<{
    characterId: string;
    name: string;
    subjectToken?: string;
    speakerToken?: string;
    /** Exact, unique, standalone identity sentence in the paired H3 prompt. */
    referenceAnchor: string;
  }>;
}

export type CharacterPresence = 'visible' | 'offscreen' | 'mentioned';
/** Model-authored participation in the paired final H3, never a cast mandate. */
export interface PromptCharacterParticipation {
  version: 1;
  characters: Array<{
    characterId: string;
    name: string;
    presence: CharacterPresence;
    shotIndex: number;
    /** A literal short excerpt from the corresponding final H3 shot. */
    evidence: string;
    speaking?: boolean;
  }>;
}
export interface PromptCharacterParticipationSnapshot extends PromptCharacterParticipation {
  promptFingerprint: string;
}

export interface StoryboardRevision {
  id: string;
  storyboardId?: string;
  revision?: number;
  label?: string;
  createdAt: number;
  reason?: string;
  finalPrompt: string;
  englishPrompt?: string;
  officialPromptZh?: string;
  officialPromptEn?: string;
  officialPromptSource?: string;
  officialPromptEnSource?: string;
  h3IdentityBindings?: H3IdentityBindings;
  h3IdentityBindingsEn?: H3IdentityBindings;
  /** Chinese final-delivery participation; English may share only its exact paired source. */
  h3CharacterParticipation?: PromptCharacterParticipationSnapshot;
  /** Text-only adjacent-segment handoff paired with this exact saved prompt. */
  sequencePromptHandoff?: SequencePromptHandoffStamp;
  /** Complete saved creative controls paired with this revision, if available. */
  creativeDirection?: VideoCreativeDirection;
  /** Target model paired with the saved adapted prompt, when any. */
  targetModelId?: string;
  /** Snapshot of the target request metadata paired with the official prompt. */
  targetOutput?: TargetOutput;
  /** Seedance 2.5 official natural-language output, kept separate from H3. */
  seedance25Output?: Seedance25Output;
  /** Saved shot-count authority; absent in legacy revisions. */
  shotMode?: ShotMode;
  shotCount?: number;
  recommendedShotCount?: number;
  durationSec?: number;
  shots?: VideoShot[];
  /** Sound timing paired with the saved shot layout; absent in legacy revisions. */
  audioLedger?: AudioCue[];
  /** Exact planning inputs and API provenance paired with this saved text. */
  promptPlan?: PromptPlanSnapshot;
  promptTrace?: PromptTrace;
  metadata?: Record<string, unknown>;
}

export interface PromptPlanSnapshot {
  canonicalPrompt: string;
  durationSec: number;
  aspectRatio: string;
  resolution: string;
  audioMode: 'stereo' | 'none';
  workflow: Workflow;
  inputMode: InputMode;
  shotIds: string[];
  referenceAssetIds: string[];
  constraints: string[];
  trace: {
    ruleSetId: string;
    converterId: string;
    styleId?: string;
    directorStyle?: string;
  };
}

export interface TargetOutput {
  targetId: string;
  prompt: string;
  parameters: Record<string, unknown>;
  referenceManifest: Array<Record<string, unknown>>;
  warnings: string[];
  generatedAt: number;
}

export interface GenerationPlanItem {
  id?: string;
  kind?: 'pilot' | 'batch';
  status?: 'pilot' | 'queued';
  shotIds: string[];
  label: string;
  priority: 'smoke-test' | 'normal' | 'follow-up';
  estimatedUnits: number;
  referenceCount: number;
  durationSec?: number;
}

export interface GenerationShotEstimate {
  shotId: string;
  index: number;
  durationSec: number;
  referenceCount: number;
  imageReferenceCount: number;
  videoReferenceCount: number;
  audioReferenceCount: number;
  estimatedUnits: number;
  riskScore: number;
  riskReasons: string[];
  selectedForPilot: boolean;
}

export interface GenerationPlan {
  targetId?: string;
  selectedShotIds: string[];
  batches: GenerationPlanItem[];
  totalEstimatedUnits: number;
  totalDurationSec?: number;
  totalReferenceCount?: number;
  uniqueReferenceCount?: number;
  warnings?: string[];
  shots?: GenerationShotEstimate[];
  createdAt: number;
}

export interface GridVisualState {
  index: number;
  subject: string;
  action: string;
  camera: string;
  transition: string;
  lighting?: string;
  result?: string;
}

/** An AI-planned still within a user-sized image batch, independent of video shots. */
export interface StoryboardImageFrameMetadata {
  /** Full-board image batch identity; frozen across retries and separate from image slot count. */
  imageFrameBatchId?: string;
  /** One-based image position across the current segment's custom batch. */
  imageFrameIndex?: number;
  imageFrameCount?: number;
  /** Frozen AI-selected single moment, retained for regeneration and stale-result checks. */
  imageFrameDescription?: string;
  /** Optional AI-selected second on the current segment's local timeline. */
  imageFrameTimeSec?: number;
}

export interface Seedance25Output {
  targetId: 'seedance-2.5';
  promptZh: string;
  promptEn?: string;
  durationSec: number;
  sourceFingerprint: string;
  referenceManifest: Array<Record<string, unknown>>;
  warnings: string[];
  generatedAt: number;
  englishSourceFingerprint?: string;
  englishError?: string;
}

export interface ReferenceAsset extends StoryboardImageFrameMetadata {
  id: string;
  /** Ordinary reference association copy; the original asset keeps its immutable provenance. */
  linkedFromAssetId?: string;
  name: string;
  type: AssetType;
  role: AssetRole;
  fileName?: string;
  dataUrl?: string;
  /** Remote image URL returned by an image backend. Kept separate from local dataUrl. */
  url?: string;
  /** App-managed path relative to the desktop asset root. */
  relativePath?: string;
  checksum?: string;
  sizeBytes?: number;
  managed?: boolean;
  missing?: boolean;
  duplicateOfAssetId?: string;
  mimeType?: string;
  importedAt?: number;
  /** Entity in the project bible that this image was generated from or uploaded for. */
  sourceEntityId?: string;
  sourceEntityKind?: 'character' | 'location' | 'prop';
  /** Storyboard and shot that deterministically produced this image. */
  sourceStoryboardId?: string;
  sourceVideoTaskId?: string;
  /** Immutable extraction/edit provenance, never a generation-task id. */
  sourceVideoAssetId?: string;
  sourceVideoChecksum?: string;
  sourceTimeSec?: number;
  sourceFrameIndex?: number;
  sourceVideoEditId?: string;
  sourceClipId?: string;
  videoEditDraft?: VideoWorkbenchDraft;
  /** Self-contained, credential-free generation provenance; survives deleting its task record. */
  videoSourceTask?: VideoGenerationTask;
  sourceShotId?: string;
  prompt?: string;
  visualAnchor?: string;
  imageVariant?: ImageVariant;
  /** Private-profile images never enter ordinary character/storyboard references. */
  referenceScope?: 'general' | 'nsfw-private-profile';
  nsfwPrivatePart?: NsfwPrivatePart;
  negativePrompt?: string;
  /** Exact image-prompt converter selection used to create this asset. */
  imagePromptRuleSetId?: string;
  imagePromptRuleSetName?: string;
  imagePromptRuleSetVersion?: string;
  imagePromptPresetId?: string;
  imagePromptPresetName?: string;
  imagePromptPresetVersion?: string;
  imagePromptFormat?: ImagePromptFormat;
  /** Physical image-generation backend, independent of the selected prompt rule's backend/format. */
  imageBackend?: ImageApiConfig['backend'];
  /** Explicit provenance, never inferred from prompt text or image tags. */
  imageGenerationMode?: 'text-to-image' | 'image-to-image';
  /** Safe original-image/API locators retained when a completed task is deleted. */
  imageRegenerationSnapshot?: ImageAssetRegenerationSnapshot;
  /** Frozen requested pixels, separate from actual asset width/height; survives deleting the task. */
  imageRequestSize?: { width: number; height: number; sizeOverride?: boolean };
  gridStates?: GridVisualState[];
  /** 0.4 multimodal reference metadata. */
  mediaType?: ReferenceMediaType;
  referenceRole?: ReferenceRole;
  source?: 'upload' | 'generated' | 'remote' | 'imported' | 'derived';
  durationSec?: number;
  width?: number;
  height?: number;
  sampleRate?: number;
  channelCount?: number;
  waveform?: number[];
  thumbnailAssetId?: string;
  /** Optional extracted/linked boundary frames for video references. */
  firstFrameAssetId?: string;
  lastFrameAssetId?: string;
  /** Target model ids this asset is intended to bind to. */
  targetBindings?: string[];
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface StoryAnalysisCharacter {
  name?: string;
  existingEntityId?: string;
  aliases?: string[];
  baseCharacterId?: string;
  /** Optional identity-variant metadata. A variant is a separate visual asset. */
  baseName?: string;
  formLabel?: string;
  variantOf?: string;
  transformationType?: string;
  gender?: string;
  apparentAge?: string;
  actualAge?: string;
  height?: string;
  race?: string;
  /** Optional visual body-plan category; absent on legacy model responses. */
  morphology?: MorphologyKind | string;
  /** Concrete anatomy/structure lock shared by downstream prompt builders. */
  bodyPlan?: string;
  appearance?: string;
  outfit?: string;
  signatureProps?: string;
  personality?: string;
  motionHabits?: string;
  anchor?: string;
  negativeContinuity?: string;
  nsfwProfile?: CharacterNsfwProfile;
}

export interface StoryAnalysisLocation {
  name?: string;
  existingEntityId?: string;
  aliases?: string[];
  description?: string;
  timeWeather?: string;
  lighting?: string;
  palette?: string;
  fixedProps?: string;
  anchor?: string;
}

export interface StoryAnalysisProp {
  name?: string;
  existingEntityId?: string;
  aliases?: string[];
  category?: string;
  material?: string;
  appearance?: string;
  effect?: string;
  stateRules?: string;
}

export interface VideoShot {
  id: string;
  index: number;
  startSec: number;
  endSec: number;
  purpose: string;
  subject: string;
  action: string;
  camera: string;
  transition: string;
  lighting: string;
  sound: string;
  result: string;
  referenceAssetIds: string[];
  /** Semantic source beats that this shot actually visualizes. */
  sourceBeatIds?: string[];
  /** UTF-16 start of the exact source excerpt visualized by this shot. */
  sourceStart?: number;
  /** UTF-16 end of that excerpt; it may be a sub-range of a coarser semantic beat. */
  sourceEnd?: number;
  /** Unlocated shots retain their model decisions, but must not claim invented source spans. */
  sourceLocationStatus?: 'located' | 'unlocated';
  /** Preserve the AI's source explanation even when it is not an exact original excerpt. */
  sourceExcerpt?: string;
  /** A new AI-authored shot must not be rejected or rewritten by legacy prose heuristics. */
  authoredBy?: 'text-api';
  /** Optional model-authored canonical fields. Missing legacy values are not inferred locally. */
  space?: string;
  performance?: string;
  direction?: string;
  dialogue?: string;
  prompt: string;
  locked: boolean;
  /** Visible state in this shot, separate from the character's stable body anchors. */
  nsfwContinuity?: NsfwShotContinuityState;
  /** AI-selected current-shot visible detail scope; absent means public identity only. */
  visiblePrivatePartsByCharacter?: Record<string, NsfwPrivatePart[]>;
}

/** A complete shot decision authored by the text model in automatic mode. */
export interface AiStoryboardShotPlan {
  startSec: number;
  endSec: number;
  /** Model-provided source explanation; unlocated text is retained without claiming an exact source range. */
  sourceExcerpt: string;
  sourceUnitIds?: string[];
  sourceStart?: number;
  sourceEnd?: number;
  sourceLocationStatus?: 'located' | 'unlocated';
  purpose: string;
  subject: string;
  action: string;
  camera: string;
  transition: string;
  lighting: string;
  sound: string;
  result: string;
  /** The model, not a local prose parser, may supply these presentation fields. */
  space?: string;
  performance?: string;
  direction?: string;
  dialogue?: string;
  /** Character IDs and explicitly selected visible parts, never whole private dossiers. */
  visiblePrivatePartsByCharacter?: Record<string, NsfwPrivatePart[]>;
}

export interface AiStoryboardPlan {
  reason?: string;
  breakdown?: string[];
  shots: AiStoryboardShotPlan[];
}

/** A semantic long-story segment authored by the text model.  The model
 * groups complete authoritative master shots; the renderer later maps those
 * groups to local H3 timelines without inventing new cut points. */
export interface AiSequenceSegmentPlan {
  sourceShotIds: string[];
  /** Model-authored segment text; source-beat IDs are optional provenance, not required prose assembly. */
  content?: string;
  /** Optional model-provided beat evidence; shot provenance remains primary. */
  sourceBeatIds?: string[];
  /** Optional self-reported duration, checked against the referenced shots. */
  durationSec?: number;
  /** Preferred hard boundary: the last complete master shot in this segment. */
  boundaryAfterShotId?: string;
  /** Optional absolute boundaries; accepted as evidence and snapped to shot ends. */
  globalStartSec?: number;
  globalEndSec?: number;
  title: string;
  summary: string;
  narrativePurpose: string;
  entryState: string;
  exitState: string;
  transitionHint: string;
  boundaryReason?: string;
  continuityPack?: string;
}

export interface AiSequenceSegmentationPlan {
  reason?: string;
  breakdown?: string[];
  segments: AiSequenceSegmentPlan[];
}

export interface PromptTrace {
  modelRuleSetId: string;
  converterPresetId: string;
  stylePresetId?: string;
  sourceDocumentIds: string[];
  referenceAssetIds: string[];
  generatedAt: number;
  mode: 'local-fallback' | 'text-api';
  /** Exact fingerprint of the final prompt body produced by the text converter. */
  convertedPromptFingerprint?: string;
  shotRecommendationMode?: 'local-rule' | 'text-api';
  /** Present only when the text model returned every shot field, not merely a count. */
  shotPlanMode?: 'ai-complete' | 'locally-edited';
  directorDecisionMode?: 'local-rule' | 'text-api';
  effectiveWorkflow?: Workflow;
  smartDirectorReason?: string;
  directorStyleId?: string;
  directorStyleName?: string;
  directorStyleSummary?: string;
  cameraTerms?: string[];
  lightingTerms?: string[];
  visualStyle?: string;
}

/** Ordinary story/appearance facts only; no assets or private visual dossiers. */
export type SemanticSequenceCharacter = Pick<Character, 'name'> & Partial<Pick<Character,
  'id' | 'aliases' | 'baseName' | 'formLabel' | 'variantOf' | 'transformationType'
  | 'gender' | 'apparentAge' | 'actualAge' | 'height' | 'race' | 'morphology' | 'bodyPlan'
  | 'appearance' | 'outfit' | 'signatureProps' | 'personality' | 'motionHabits' | 'anchor'
  | 'negativeContinuity'
>>;

/** Model-authored story causality, not a local actor guess or a visibility list. */
export interface SemanticEventCausality {
  actor: string;
  target: string;
  action: string;
  result: string;
  /** Source wording supporting this relation, including contextual evidence. */
  evidence: string;
  certainty: 'explicit' | 'context-supported' | 'unknown';
  actorCharacterId?: string;
  targetCharacterId?: string;
}

/** An adopted visual description retains its actual pre-conversion source. */
export interface StoryVisualConversionSnapshot {
  id: string;
  chapterId: string;
  sourceName: string;
  sourceText: string;
  resultText: string;
  createdAt: number;
}

export interface SemanticSegmentSource {
  /** AI-selected original evidence, separate from the AI-authored segment body.
   * Offsets, when supplied, use JavaScript UTF-16 indices into the saved source. */
  sourceEvidence: Array<{ text: string; sourceStart?: number; sourceEnd?: number }>;
  /** IDs may recur across segments for different phases of one long event. */
  events: Array<{ id: string; description: string; phase?: string; causality?: SemanticEventCausality }>;
  /** IDs may recur for an explicitly continuous utterance, never a local replay. */
  dialogues: Array<{ id: string; speaker: string; text: string; language?: string; continuation?: string }>;
}

export interface SemanticSequencePlanningSnapshot {
  version: 1;
  directorSettingsFingerprint: string;
  /** Missing on previously saved semantic plans; interpreted as AI estimation. */
  durationMode?: SequenceDurationMode;
  /** Present only for a fixed request; the complete budget is N full D windows. */
  requestedTotalDurationSec?: number;
  creativeDirection: VideoCreativeDirection;
  pacing?: StoryPacingContext;
  characterContinuity: SemanticSequenceCharacter[];
  /** Only a conversion snapshot matching the planned story can supply this. */
  originalSourceContext?: StoryVisualConversionSnapshot;
  /** Optional per-segment photography preference; does not fix N or full-film shots. */
  shotMode?: ShotMode;
  shotCount?: number;
}

export interface VideoSegment {
  id: string;
  index: number;
  title: string;
  globalStartSec: number;
  globalEndSec: number;
  durationSec: number;
  content: string;
  summary: string;
  sourceSceneIds: string[];
  sourceBeatIds: string[];
  /** Original shot IDs cut from the plan's authoritative full timeline. */
  sourceShotIds?: string[];
  /** Present for raw-story semantic planning, which has no full-film master shots. */
  semanticSource?: SemanticSegmentSource;
  /** Seconds added by automatic master-shot boundary alignment. */
  autoExtendedBySec?: number;
  narrativePurpose: string;
  entryState: string;
  exitState: string;
  transitionHint: string;
  /** Why the AI chose this boundary instead of cutting at a fixed character/time offset. */
  boundaryReason?: string;
  /** Continuity facts that the next AI-generated segment must inherit. */
  continuityPack?: string;
  storyboardId?: string;
  status: VideoSegmentStatus;
  /** Last actionable generation failure or repair reason shown in the UI. */
  failureReason?: string;
  locked?: boolean;
  /** True only after the user explicitly replaces beat-derived segment text. */
  contentOverridden?: boolean;
}

export interface VideoSequencePlan {
  id: string;
  chapterId?: string;
  sourceStale?: boolean;
  title: string;
  sourceStoryTitle: string;
  sourceStoryContent: string;
  /** Hash of sourceStoryContent; a mismatch makes this plan stale. */
  sourceContentHash?: string;
  /** Absent on legacy master-timeline plans; never inferred during loading. */
  planningMode?: 'master-timeline' | 'semantic-segments';
  semanticPlanningSnapshot?: SemanticSequencePlanningSnapshot;
  durationMode: SequenceDurationMode;
  /** Original budget for this master request; never replaced by its AI result. */
  masterPlanningInitialDurationSec?: number;
  requestedTotalDurationSec?: number;
  totalDurationSec: number;
  segmentDurationSec: number;
  segmentationMode: SequenceSegmentationMode;
  /** Who authored the semantic segment boundaries. Legacy plans omit this. */
  segmentationSource?: 'ai' | 'local';
  /** Human-readable rationale returned by the AI segmentation pass. */
  segmentationReason?: string;
  fitStatus: SequenceFitStatus;
  estimateReason?: string;
  /** Request-owned estimate and pacing; absent on legacy plans. */
  durationEstimateSnapshot?: SequenceDurationEstimateSnapshot;
  /** Storyboard containing the authoritative full-duration prompt/timeline. */
  masterStoryboardId?: string;
  planningStage?: 'master-draft' | 'master-confirmed' | 'segmented';
  masterPromptConfirmedFingerprint?: string;
  masterPromptConfirmedAt?: number;
  /** Snapshot of the director settings used to generate the authoritative master prompt. */
  masterPromptDirectorSettingsFingerprint?: string;
  masterPromptDirectorSettingsConfirmedAt?: number;
  segments: VideoSegment[];
  /** True only after the user explicitly reorders whole beat-contiguous segments. */
  segmentOrderOverridden?: boolean;
  /** Exact review fingerprint last confirmed by the user; omitted means review is required. */
  reviewConfirmedFingerprint?: string;
  /** Exact review fingerprint for which the user acknowledged compressed pacing. */
  compressedRiskAcknowledgedFingerprint?: string;
  reviewConfirmedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** Compact provenance only: no video frame, media path or copied prompt text.
 * A prepared source stamp is not current until the reviewed Chinese result is
 * sealed with its own storyboard identity and result fingerprint. */
export interface SequencePromptHandoffStamp {
  version: 'sequence-prompt-handoff-v1';
  projectId: string;
  planId: string;
  segmentId: string;
  segmentIndex: number;
  previousSegmentId: string;
  previousSegmentIndex: number;
  previousStoryboardId: string;
  previousPromptFingerprint: string;
  sourceFingerprint: string;
  openingOverlapSec: 0.5;
  storyboardId?: string;
  resultFingerprint?: string;
}

/** Image-only selections: never participate in video/H3 prompt invalidation. */
export interface StoryboardImageToImageSettings {
  referenceAssetIds: string[];
  selectedShotIds: string[];
  referenceAssetIdsByShotId: Record<string, string[]>;
}

export interface Storyboard {
  id: string;
  chapterId?: string;
  sourceStale?: boolean;
  /** Current editable dossier changed; historical delivery strings remain available. */
  characterDossierDirty?: { characterIds: string[]; updatedAt: number };
  sceneId: string;
  sourceSceneIds?: string[];
  sourceStoryTitle?: string;
  sourceStoryContent?: string;
  /** Hash of the source text used when this storyboard was generated. */
  sourceContentHash?: string;
  sourceSceneSnapshots?: Scene[];
  workflow: Workflow;
  inputMode: InputMode;
  durationSec: number;
  durationPreset: DurationPreset;
  shotMode: ShotMode;
  shotCount?: number;
  recommendedShotCount?: number;
  shotCountReason?: string;
  /** Image-only total; unset follows the video shot count and never changes the video plan. */
  storyboardImageCount?: number;
  /** Independent, explicit references for direct storyboard image-to-image generation. */
  imageToImage?: StoryboardImageToImageSettings;
  pace: Pace;
  aspectRatio: string;
  resolution: string;
  audioMode: 'stereo' | 'none';
  stylePresetId: string;
  ruleSetId: string;
  converterPresetId: string;
  directorStyleId?: string;
  directorStyleName?: string;
  directorStyleSummary?: string;
  cameraTerms?: string[];
  lightingTerms?: string[];
  visualStyle?: string;
  smartDirectorReason?: string;
  globalLock: string;
  extraRequirement?: string;
  /** Complete resolved creative controls; absent on legacy storyboards. */
  creativeDirection?: VideoCreativeDirection;
  /** User-checked image assets applied to every storyboard/boundary image request. */
  globalReferenceAssetIds?: string[];
  shots: VideoShot[];
  finalPrompt: string;
  /** True when a legacy non-canonical prompt was preserved during migration. */
  promptMigrationPending?: boolean;
  promptPlan?: PromptPlanSnapshot;
  englishPrompt?: string;
  englishPromptSource?: string;
  /** Official target-format Chinese delivery prompt derived from finalPrompt. */
  officialPromptZh?: string;
  /** English translation derived from officialPromptZh. */
  officialPromptEn?: string;
  /** Exact canonical prompt used to derive officialPromptZh. */
  officialPromptSource?: string;
  /** Exact officialPromptZh text used to derive officialPromptEn. */
  officialPromptEnSource?: string;
  /** English-only failure; a qualified current Chinese H3 prompt remains usable. */
  officialPromptEnError?: string;
  /** Exact AI-authored anchors paired with the current Chinese/English H3 bodies. */
  h3IdentityBindings?: H3IdentityBindings;
  h3IdentityBindingsEn?: H3IdentityBindings;
  /** Chinese final-delivery participation; English may share only its exact paired source. */
  h3CharacterParticipation?: PromptCharacterParticipationSnapshot;
  createdAt: number;
  updatedAt: number;
  promptTrace?: PromptTrace;
  /** Target model used for the latest adapted output. */
  targetModelId?: string;
  targetOutput?: TargetOutput;
  /** On-demand Seedance 2.5 bilingual delivery, never overwrites H3 output. */
  seedance25Output?: Seedance25Output;
  firstFrameAssetId?: string;
  lastFrameAssetId?: string;
  audioLedger?: AudioCue[];
  generationPlan?: GenerationPlan;
  continuityReport?: ContinuityReport;
  revisions?: StoryboardRevision[];
  activeRevisionId?: string;
  sequencePlanId?: string;
  segmentId?: string;
  segmentIndex?: number;
  segmentCount?: number;
  globalStartSec?: number;
  globalEndSec?: number;
  continuityIn?: string;
  continuityOut?: string;
  /** AI-authored opening handoff based on the preceding segment's final text. */
  sequencePromptHandoff?: SequencePromptHandoffStamp;
}

export interface Scene {
  id: string;
  chapterId?: string;
  sourceStale?: boolean;
  title: string;
  content: string;
  summary: string;
  /** Hash and UTF-16 half-open range of the source text used for this scene. */
  sourceContentHash?: string;
  sourceStart?: number;
  sourceEnd?: number;
  characterIds: string[];
  locationId?: string;
  locationIds?: string[];
  propIds: string[];
  storyboardIds: string[];
  createdAt: number;
  updatedAt: number;
}

/** Unsubmitted editor text, kept independently from the confirmed source. */
export interface StoryDraft {
  name: string;
  content: string;
  updatedAt: number;
}

/** Chapter-owned editor state; shared dossiers, media and jobs stay on Project. */
export interface ChapterWorkspace {
  storyDraft?: StoryDraft;
  directorControls?: Record<string, unknown>;
  videoDirector?: unknown;
  directorSettingsConfirmedFingerprint?: string;
  directorSettingsConfirmedAt?: number;
  directorLookRequirement?: string;
  directorLookDraft?: DirectorLookDraft;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  /** Project-library workspace marker only; video workers continue normally. */
  backgroundSuspended?: boolean;
  sourceDocuments: SourceDocument[];
  /** Adopted picture-description conversions; legacy projects omit this list. */
  storyVisualConversions?: StoryVisualConversionSnapshot[];
  activeChapterId?: string;
  chapterWorkspaces?: Record<string, ChapterWorkspace>;
  storyDraft?: StoryDraft;
  characters: Character[];
  locations: Location[];
  props: Prop[];
  scenes: Scene[];
  storyboards: Storyboard[];
  sequencePlans: VideoSequencePlan[];
  /** Last explicitly confirmed director parameter snapshot for this project. */
  directorSettingsConfirmedFingerprint?: string;
  directorSettingsConfirmedAt?: number;
  /** Optional instructions for the director/visual AI autofill only, not a generation parameter. */
  directorLookRequirement?: string;
  /** Latest explicit editor choices; independent of confirmed generation snapshots. */
  directorLookDraft?: DirectorLookDraft;
  assets: ReferenceAsset[];
  generationTasks: GenerationTask[];
  /** Independent local post-production; does not enter the paid generation queue. */
  videoWorkbench?: VideoWorkbenchState;
  createdAt: number;
  updatedAt: number;
}

export interface VideoGenerationTask {
  id: string;
  /** Removed from task lists; a terminal source retained for exact continuation lineage. */
  historyOnly?: true;
  /** Added after video tasks shipped; absence still means a legacy video task. */
  kind?: 'video';
  videoJob?: VideoGenerationJob;
  storyboardId: string;
  targetId: string;
  status: 'draft' | 'submitting' | 'submitted' | 'running' | 'succeeded' | 'failed' | 'unknown';
  remoteTaskId?: string;
  requestBody: Record<string, unknown>;
  response?: unknown;
  resultUrl?: string;
  resultAssetId?: string;
  error?: string;
  sequencePlanId?: string;
  segmentId?: string;
  segmentIndex?: number;
  /** Optional durable grouping for one-click long-story video submission. */
  batchId?: string;
  batchLabel?: string;
  batchItemKey?: string;
  /** One-based position in the user's selected batch. */
  batchIndex?: number;
  batchTotal?: number;
  /** Bounded preparation/submission concurrency frozen for this batch. */
  batchConcurrency?: number;
  /** Content-derived identity used to suppress duplicate billable submissions. */
  requestFingerprint?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Immutable managed-media locator for an explicitly selected reference image.
 * No pixels, remote URLs, API credentials or live project-asset lookups: the
 * checksum makes replacing a local file fail clearly instead of changing a retry.
 */
export interface ImageReferenceAssetSnapshot {
  id: string;
  name: string;
  type: AssetType;
  role: AssetRole;
  relativePath: string;
  checksum: string;
  managed: true;
  mediaType: 'image';
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  sourceEntityId?: string;
  sourceEntityKind?: 'character' | 'location' | 'prop';
  referenceScope?: 'general' | 'nsfw-private-profile';
  nsfwPrivatePart?: NsfwPrivatePart;
}

/** Result assets already own their prompt, requested size and frame metadata;
 * this small complement stores only credential-free execution provenance. */
export interface ImageAssetRegenerationSnapshot {
  version: 1;
  model: string;
  imageApiSnapshot: ImageApiExecutionSnapshot;
  referenceAssetSnapshots: ImageReferenceAssetSnapshot[];
  sourceFingerprint?: string;
  regenerationRootTaskId?: string;
  regenerationBaseName?: string;
}

export interface ImageGenerationTask extends StoryboardImageFrameMetadata {
  id: string;
  kind: 'image';
  name: string;
  assetKind: 'character' | 'location' | 'prop' | 'grid' | 'storyboard';
  imageVariant: ImageVariant;
  /** Absent for historical tasks; explicit direct mode never invokes the text converter. */
  imageGenerationMode?: 'text-to-image' | 'image-to-image';
  /** Structured private-profile routing metadata; labels are not a safety boundary. */
  referenceScope?: 'general' | 'nsfw-private-profile';
  nsfwPrivatePart?: NsfwPrivatePart;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  /** An explicit workbench size choice; frozen so a retry cannot silently use a workflow default. */
  sizeOverride?: boolean;
  backend: ImageApiConfig['backend'];
  model: string;
  /** Frozen execution parameters; credentials are resolved only from the same saved API connection. */
  imageApiSnapshot?: ImageApiExecutionSnapshot;
  /** Exact image-prompt converter selection used before backend submission. */
  imagePromptRuleSetId?: string;
  imagePromptRuleSetName?: string;
  imagePromptRuleSetVersion?: string;
  imagePromptPresetId?: string;
  imagePromptPresetName?: string;
  imagePromptPresetVersion?: string;
  imagePromptFormat?: ImagePromptFormat;
  sourceEntityId?: string;
  sourceStoryboardId?: string;
  sourceShotId?: string;
  batchId?: string;
  /** Workbench image variations, one separately tracked request per member. */
  batchIndex?: number;
  batchCount?: number;
  seed?: number;
  sourceFingerprint?: string;
  /** The immediate image task from which this manual regeneration was started. */
  regenerationSourceTaskId?: string;
  /** Stable original task identity shared by every regeneration in this family. */
  regenerationRootTaskId?: string;
  /** Original human-readable base name; prevents nested names such as “-2-2”. */
  regenerationBaseName?: string;
  /** Frozen converter input and reference choices, never media pixels or credentials. */
  referenceAssetIds?: string[];
  primaryReferenceAssetIds?: string[];
  /** Exact submitted reference identities and immutable media locations, independent of current assets. */
  referenceAssetSnapshots?: ImageReferenceAssetSnapshot[];
  conversionSource?: string;
  /** Frozen identity/world evidence for AI conversion only, never final prompt text. */
  conversionIdentityContext?: string;
  converterSystemPrompt?: string;
  bindingWarning?: string;
  resultUrl?: string;
  resultAssetId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AutofillGenerationTask {
  id: string;
  kind: 'autofill';
  name: string;
  assetKind: 'character' | 'location' | 'prop' | 'grid';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  requestedFields: string[];
  sourceEntityId?: string;
  customRequirement?: string;
  model: string;
  result?: Record<string, string>;
  bindingWarning?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export type GenerationTask = VideoGenerationTask | ImageGenerationTask | AutofillGenerationTask;

export interface TextApiConfig {
  enabled: boolean;
  provider: 'openai_compatible' | 'gemini' | 'claude' | 'deepseek';
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  vision: boolean;
}

export interface VisionApiConfig extends TextApiConfig {
  enabled: boolean;
}

export interface ComfyUIWorkflowPreset {
  id: string;
  name: string;
  workflowJson: string;
  createdAt: number;
  updatedAt: number;
}

export interface ImageApiConfig {
  enabled: boolean;
  backend: 'openai' | 'sd_webui' | 'comfyui' | 'novelai';
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Legacy/current mirror of the selected ComfyUI workflow. */
  workflowJson?: string;
  comfyuiPathMode?: 'preset' | 'custom';
  comfyuiPromptPath?: string;
  comfyuiWorkflows?: ComfyUIWorkflowPreset[];
  activeComfyuiWorkflowId?: string | null;
}

export interface ImageApiExecutionSnapshot {
  version: 1;
  /** null means the current API configuration was used without a saved profile. */
  profileId: string | null;
  /** Digests only: URLs and workflows can contain embedded credentials. */
  connectionFingerprint: string;
  executionFingerprint: string;
  config: Pick<ImageApiConfig, 'enabled' | 'backend' | 'model'>;
}

export interface VideoTaskApiConfig {
  enabled: boolean;
  endpoint: string;
  statusEndpointTemplate: string;
  apiKey: string;
  authHeader: string;
  authScheme: string;
  taskIdPath: string;
  statusPath: string;
  resultUrlPath: string;
  provider?: 'generic' | 'minimax' | 'runninghub' | 'rhtv_web';
  rhtvMode?: 'text' | 'first' | 'first_last' | 'reference';
  rhtvDuration?: number;
  rhtvResolution?: string;
  rhtvAspectRatio?: string;
  model?: string;
  /** RunningHub AI 应用 ID；仅 provider 为 runninghub 时使用。 */
  runningHubAppId?: string;
  /** Prefer final video outputs from these cloud node IDs; never pick image previews. */
  runningHubOutputNodeIds?: string[];
  /** Ordered image-slot capacity; individual submissions may use fewer slots. */
  runningHubImageRoles?: ReferenceRole[];
  runningHubMappedFields?: Array<{ nodeId: string; fieldName: string; kind: 'prompt' | 'image' | 'image-count' | 'parameter'; imageIndex?: number; emptyValue?: '' | 'None' | 'example.png'; imageCountMode?: 'prefix'; imageCountSource?: 'explicit' | 'verified-app'; parameter?: string; originalValue?: unknown }>;
  /** Local controls for mapped parameters; never included in the cloud request body. */
  runningHubParameterControls?: Record<string, RunningHubVideoFieldControl>;
  /** JSON placeholders: {{prompt}}, {{model}}, {{images}}, {{first_image}}, {{last_image}}, {{parameters}}. */
  requestTemplate?: string;
  progressPath?: string;
  errorPath?: string;
  fileIdPath?: string;
  fileEndpointTemplate?: string;
  fileUrlPath?: string;
  cancelEndpointTemplate?: string;
  cancelMethod?: 'POST' | 'DELETE';
  /** Optional multipart image-upload endpoint; absent uses data URLs. */
  imageUploadEndpoint?: string;
  imageUploadField?: string;
  imageUploadUrlPath?: string;
}

export interface ApiCredentialEntry {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  createdAt: number;
  updatedAt: number;
}

export interface SavedApiProfileMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export type TextApiProfile = TextApiConfig & SavedApiProfileMeta;
export type VisionApiProfile = VisionApiConfig & SavedApiProfileMeta;
export type ImageApiProfile = ImageApiConfig & SavedApiProfileMeta;

export interface AppSettings {
  textApi: TextApiConfig;
  visionApi: VisionApiConfig;
  imageApi: ImageApiConfig;
  videoTaskApi: VideoTaskApiConfig;
  videoBackend?: VideoGenerationBackend;
  videoSource?: VideoGenerationSource;
    /** Shared preference; each frozen connection enforces this limit across its single and batch tasks. */
  videoExecutionMode?: 'queue' | 'concurrent';
  videoExecutionConcurrency?: number;
  runningHubVideo?: RunningHubVideoConfig;
  comfyuiVideo?: ComfyVideoConfig;
  videoApiProfiles?: VideoApiProfile[];
  activeVideoApiProfileId?: string | null;
  apiCredentialBook: ApiCredentialEntry[];
  textApiProfiles: TextApiProfile[];
  visionApiProfiles: VisionApiProfile[];
  imageApiProfiles: ImageApiProfile[];
  activeTextApiProfileId: string | null;
  activeVisionApiProfileId: string | null;
  activeImageApiProfileId: string | null;
  /** Private workbench override only. Null/absent follows the normal image API setting. */
  privateImageApiProfileId?: string | null;
  /** Last explicit image rule choice for each generation backend. */
  imagePromptRuleSetIdByBackend: Partial<Record<ImageApiConfig['backend'], string>>;
  /** Private-image rule choices are kept separate from ordinary generation. */
  privateImagePromptRuleSetIdByBackend: Partial<Record<ImageApiConfig['backend'], string>>;
  /** Last explicit image category preset choice for each asset kind. */
  imagePromptPresetIdByAssetKind: Partial<Record<ImagePromptAssetKind, string>>;
  /** Independent, persisted ordinary/private output-size choices. */
  imageOutputSizes?: ImageOutputSizePreferences;
  /** Shared by storyboard-image entry points; independent of ordinary/private reference images. */
  storyboardImageOutputSize?: StoryboardImageOutputSizePreference;
  defaultRuleSetId: string;
  defaultStoryExpansionPresetId: string;
  defaultStylePresetId: string;
  defaultDurationPreset: DurationPreset;
  defaultDurationSec: number;
  defaultShotMode: ShotMode;
  defaultShotCount: number;
  assetFilter: ReferenceMediaType | 'all';
  autoBackup: boolean;
  restorePointLimit: number;
  theme: 'ink' | 'light';
  /** Global renderer font scale. 100 keeps the original typography size. */
  uiFontScalePercent: number;
}

export interface RuleSet {
  id: string;
  name: string;
  description: string;
  mode: 'timeline' | 'custom';
  baseRules: string;
  continuityRules: string;
  outputRules: string;
  enabled: boolean;
  version: string;
  updatedAt: number;
}

export interface ConverterPreset {
  id: string;
  name: string;
  workflow: ConverterWorkflow;
  inputMode: InputMode | 'all';
  scope?: 'video' | 'reference-video' | 'grid-image' | 'character-image' | 'location-image' | 'prop-image';
  systemPrompt: string;
  outputRules: string;
  enabled: boolean;
  version: string;
  updatedAt: number;
}

export interface StoryExpansionPreset {
  id: string;
  name: string;
  systemPrompt: string;
  outputRules: string;
  enabled: boolean;
  version: string;
  updatedAt: number;
}

export interface StylePreset {
  id: string;
  name: string;
  category: string;
  visual: string;
  camera: string;
  lighting: string;
  sound: string;
  updatedAt: number;
}

export interface AppState {
  /** Persistent state schema. Current value is maintained by storage migration. */
  schemaVersion: number;
  project: Project;
  /** All projects kept in the local project library, including the active one. */
  projects: Project[];
  /** ID of the project currently shown in the workspace. */
  activeProjectId: string;
  settings: AppSettings;
  /** Complete user-editable image prompt rule and category-preset library. */
  imagePromptRules: ImagePromptRulesState;
  ruleSets: RuleSet[];
  converterPresets: ConverterPreset[];
  storyExpansionPresets: StoryExpansionPreset[];
  stylePresets: StylePreset[];
}

export interface ShotRecommendation {
  count: number;
  min: number;
  max: number;
  reason: string;
  breakdown: string[];
}

export interface PromptValidationReport {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
