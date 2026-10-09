import { useState } from 'react';
import type { Project, ReferenceAsset, VideoTaskApiConfig } from '../types';
import type { VideoGenerationDraft } from '../videoGenerationTypes';
import type { AudioRetainMode, FrozenVideoAudioReference, ProjectVoicePresets, VideoAudioReference, VideoAudioTarget, VideoVoicePreset } from '../videoAudioTypes';
import { audioRetainModes, isVideoDirectorAudio, resolveVideoAudioReferences, validateVideoAudioReferences, videoAudioBindingId, videoAudioSlotCount, videoAudioTargetLabel } from '../videoAudioReferences';
import '../videoAudioReferences.css';

type AudioApi = VideoTaskApiConfig | Omit<VideoTaskApiConfig, 'apiKey'>;
type AudioMedia = Pick<ReferenceAsset, 'dataUrl' | 'url' | 'relativePath' | 'durationSec'>;

const audioUrl = (media: AudioMedia | undefined): string => media?.dataUrl || media?.url
  || (media?.relativePath ? `lianhua-asset://local/${media.relativePath.replace(/\\/gu, '/').split('/').map(encodeURIComponent).join('/')}` : '');
const targetValue = (target: VideoAudioTarget): string => target.kind === 'character' ? `char:${target.characterId}` : target.kind;
const readTarget = (value: string): VideoAudioTarget => value.startsWith('char:')
  ? { kind: 'character', characterId: value.slice(5) } : { kind: value === 'ambience' ? 'ambience' : 'voiceover' };

function useAudioImport(onImportAudio?: () => Promise<void> | void) {
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const importAudio = async () => {
    if (!onImportAudio || importing) return;
    setImporting(true); setImportError('');
    try { await onImportAudio(); }
    catch (error) { setImportError(error instanceof Error ? error.message : '音频导入未完成，请重试。'); }
    finally { setImporting(false); }
  };
  return { importing, importError, importAudio };
}

function AudioAssetSelect({ assets, assetId, label, disabled, frozen, onChange }: {
  assets: ReferenceAsset[]; assetId: string; label: string; disabled?: boolean;
  frozen?: FrozenVideoAudioReference; onChange: (assetId: string) => void;
}) {
  const selected = assets.find((asset) => asset.id === assetId);
  return <select aria-label={label} disabled={disabled} value={assetId} onChange={(event) => onChange(event.target.value)}>
    <option value="">不选择音频</option>
    {assetId && !selected && <option value={assetId} disabled={!frozen}>{frozen ? `${frozen.name} · 任务声音快照` : '所选音频已不存在'}</option>}
    {assets.map((asset) => <option key={asset.id} value={asset.id} disabled={Boolean(asset.missing) && !(frozen?.assetId === asset.id)}>
      {frozen?.assetId === asset.id ? `${frozen.name} · 任务声音快照` : `${asset.name}${asset.missing ? ' · 文件缺失' : ''}`}
    </option>)}
  </select>;
}

function AudioPreview({ media, label }: { media?: AudioMedia; label: string }) {
  const source = audioUrl(media);
  return source ? <div className="var-audio-preview"><audio controls preload="none" src={source} aria-label={label} />
    {media?.durationSec !== undefined && Number.isFinite(media.durationSec) && <small>{Math.round(media.durationSec * 10) / 10} 秒</small>}
  </div> : null;
}

export interface VideoAudioReferenceEditorProps {
  project: Project;
  draft: VideoGenerationDraft;
  api?: AudioApi;
  scope: string;
  disabled?: boolean;
  frozenAudios?: FrozenVideoAudioReference[];
  onChange: (patch: Partial<VideoGenerationDraft>) => void;
  onImportAudio?: () => Promise<void> | void;
}

/** Viewing the collapsed editor never changes project inheritance or task provenance. */
export function VideoAudioReferenceEditor({ project, draft, api, scope, disabled = false, frozenAudios, onChange, onImportAudio }: VideoAudioReferenceEditorProps) {
  const selectedApi = draft.backend === 'api' ? api : undefined;
  const capacity = videoAudioSlotCount(selectedApi);
  const references = resolveVideoAudioReferences(project, draft, selectedApi);
  const assets = project.assets.filter(isVideoDirectorAudio);
  const mode = draft.audioSelectionMode || (draft.audioReferences?.length || draft.reuseTaskId ? 'override' : 'project');
  const activeFrozen = draft.reuseTaskId ? frozenAudios : undefined;
  const issues = validateVideoAudioReferences(project, { ...draft, audioReferences: references }, selectedApi, activeFrozen);
  const { importing, importError, importAudio } = useAudioImport(onImportAudio);
  const patchReferences = (next: VideoAudioReference[]) => onChange({ audioSelectionMode: 'override', audioReferences: next, reuseTaskId: undefined });
  const changeMode = (next: 'project' | 'override' | 'none') => onChange({
    audioSelectionMode: next, audioReferences: next === 'override' ? structuredClone(references) : next === 'none' ? [] : undefined,
    reuseTaskId: undefined,
  });
  const replaceSlot = (slotIndex: number, patch: Partial<VideoAudioReference>) => {
    const index = references.findIndex((reference) => reference.slotIndex === slotIndex);
    if (index < 0) return;
    patchReferences(references.map((reference, position) => position === index ? { ...reference, ...patch } : reference));
  };
  const chooseAsset = (slotIndex: number, assetId: string) => {
    if (!assetId) { patchReferences(references.filter((reference) => reference.slotIndex !== slotIndex)); return; }
    const index = references.findIndex((reference) => reference.slotIndex === slotIndex);
    const bindingId = videoAudioBindingId(selectedApi, slotIndex);
    if (index >= 0) {
      replaceSlot(slotIndex, { assetId, bindingId });
    } else {
      patchReferences([...references, { assetId, bindingId, slotIndex, target: { kind: 'voiceover' }, retainMode: 'reference' }]);
    }
  };
  const extraSlots = [...new Set(references.map((reference) => reference.slotIndex).filter((slot) => Number.isSafeInteger(slot) && slot >= capacity))];
  const slots = [...Array.from({ length: capacity }, (_, index) => index), ...extraSlots].sort((a, b) => a - b);
  return <details className="video-audio-reference-editor" aria-label={`${scope}参考音频`}>
    <summary>选择参考音频 <span>· 声音参考 {references.length}/{capacity}</span></summary>
    <div className="var-editor-body">
      <div className="var-editor-toolbar"><label className="field"><span>音频选择方式</span>
        <select aria-label={`${scope}音频选择方式`} value={mode} disabled={disabled} onChange={(event) => changeMode(event.target.value as 'project' | 'override' | 'none')}>
          <option value="project">使用项目声音预设</option><option value="override">本段单独设置</option><option value="none">不使用参考音频</option>
        </select>
      </label>{onImportAudio && capacity > 0 && <button type="button" className="btn small" aria-label={`${scope}导入音频`} disabled={disabled || importing} onClick={() => { void importAudio(); }}>{importing ? '导入中…' : '导入音频'}</button>}</div>
      {draft.reuseTaskId && <p className="var-help">当前显示原任务保存的声音；更改选择后使用新的设置。</p>}
      {mode === 'project' && <p className="var-help">按本段实际说话人物继承项目预设；没有对白的段落不会自动加入人物声音。</p>}
      {!capacity && <p className="var-help">当前连接没有可用的参考音频槽。请先在 RunningHub 工作流的“输入映射”中配置音频文件输入。</p>}
      {(issues.length > 0 || importError) && <p className="var-warning" role="alert">{[...issues, importError].filter(Boolean).join('；')}</p>}
      {!capacity && references.length > 0 && <ul className="var-unavailable-list">{references.map((reference, index) => <li key={`${reference.bindingId}-${index}`}>
        音频槽 {reference.slotIndex + 1}：{assets.find((asset) => asset.id === reference.assetId)?.name || activeFrozen?.find((entry) => entry.assetId === reference.assetId)?.name || '原音频已不存在'} · {videoAudioTargetLabel(project, reference.target)}
      </li>)}</ul>}
      {capacity > 0 && <div className="var-slot-grid">{slots.map((slotIndex) => {
        const reference = references.find((entry) => entry.slotIndex === slotIndex);
        const frozen = reference && activeFrozen?.find((entry) => entry.slotIndex === slotIndex && entry.assetId === reference.assetId && entry.bindingId === reference.bindingId);
        const asset = reference && assets.find((entry) => entry.id === reference.assetId);
        const slotScope = `${scope}音频槽 ${slotIndex + 1}`;
        const mapped = selectedApi?.runningHubMappedFields?.some((entry) => entry.kind === 'audio' && entry.audioIndex === slotIndex);
        const unavailable = slotIndex >= capacity || !mapped;
        const duplicate = references.filter((entry) => entry.slotIndex === slotIndex);
        const selectedCharacterId = reference?.target.kind === 'character' ? reference.target.characterId : undefined;
        const stalePerson = selectedCharacterId !== undefined && !project.characters.some((character) => character.id === selectedCharacterId);
        return <div className={`var-slot-card${unavailable ? ' unavailable' : ''}`} role="group" aria-label={slotScope} data-audio-slot={slotIndex} key={slotIndex}>
          <div className="var-slot-heading"><strong>音频槽 {slotIndex + 1}</strong><button type="button" className="var-remove" aria-label={`移除${slotScope}`} disabled={disabled || !reference} onClick={() => patchReferences(references.filter((entry) => entry.slotIndex !== slotIndex))}>移除</button></div>
          {unavailable && <p className="var-warning">当前工作流没有这个输入槽，请移除或重新选择工作流；原选择仍保留。</p>}
          {duplicate.length > 1 && <p className="var-warning">此槽重复选择：{duplicate.map((entry) => assets.find((item) => item.id === entry.assetId)?.name || entry.assetId).join('、')}。请移除重复槽后重新选择。</p>}
          <label className="field"><span>参考音频</span><AudioAssetSelect assets={assets} assetId={reference?.assetId || ''} frozen={frozen} label={`${slotScope}音频资产`} disabled={disabled || unavailable || mode === 'none'} onChange={(assetId) => chooseAsset(slotIndex, assetId)} /></label>
          <div className="var-slot-options"><label className="field"><span>声音属于</span>
            <select aria-label={`${slotScope}声音用途`} value={reference ? targetValue(reference.target) : 'voiceover'} disabled={disabled || unavailable || !reference} onChange={(event) => replaceSlot(slotIndex, { target: readTarget(event.target.value) })}>
              {stalePerson && reference && <option value={targetValue(reference.target)}>原人物已不存在</option>}
              {project.characters.map((character) => <option key={character.id} value={`char:${character.id}`}>{character.name}</option>)}
              <option value="voiceover">旁白</option><option value="ambience">音乐 / 环境氛围</option>
            </select>
          </label><label className="field"><span>参考方式</span><select aria-label={`${slotScope}保留方式`} value={reference?.retainMode || 'reference'} disabled={disabled || unavailable || !reference} onChange={(event) => replaceSlot(slotIndex, { retainMode: event.target.value as AudioRetainMode })}>
            {audioRetainModes.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
          </select></label></div>
          <AudioPreview media={frozen || asset || undefined} label={`${slotScope}试听`} />
          <label className="field"><span>使用说明（可选）</span><textarea aria-label={`${slotScope}使用说明`} rows={2} value={reference?.notes || ''} disabled={disabled || unavailable || !reference} placeholder="例如：只参考音色，保留本段台词" onChange={(event) => replaceSlot(slotIndex, { notes: event.target.value })} /></label>
        </div>;
      })}</div>}
      {capacity > 0 && <p className="var-help">人物、旁白和氛围按槽分别设置；未选择的槽保留工作流原值。参考方式的效果由云端工作流支持的能力决定。</p>}
    </div>
  </details>;
}

export interface ProjectVoicePresetEditorProps {
  project: Project;
  disabled?: boolean;
  onChange: (presets: ProjectVoicePresets) => void;
  onImportAudio?: () => Promise<void> | void;
}

/** Presets store asset IDs. They are resolved per speaking segment, never broadcast to the visible cast. */
export function ProjectVoicePresetEditor({ project, disabled = false, onChange, onImportAudio }: ProjectVoicePresetEditorProps) {
  const assets = project.assets.filter(isVideoDirectorAudio);
  const presets: ProjectVoicePresets = project.voicePresets || { characters: {} };
  const { importing, importError, importAudio } = useAudioImport(onImportAudio);
  const rows: Array<{ id: string; name: string; target: VideoAudioTarget; preset?: VideoVoicePreset }> = [
    ...project.characters.map((character) => ({ id: character.id, name: character.name, target: { kind: 'character' as const, characterId: character.id }, preset: presets.characters[character.id] })),
    { id: 'voiceover', name: '旁白', target: { kind: 'voiceover' }, preset: presets.narrator },
  ];
  const setPreset = (target: VideoAudioTarget, preset: VideoVoicePreset | undefined) => {
    const next: ProjectVoicePresets = { ...presets, characters: { ...presets.characters } };
    if (target.kind === 'character') {
      if (preset) next.characters[target.characterId] = preset;
      else delete next.characters[target.characterId];
    } else {
      if (preset) next.narrator = preset;
      else delete next.narrator;
    }
    onChange(next);
  };
  return <details className="project-voice-preset-editor">
    <summary>项目声音预设 <span>· 人物与旁白</span></summary>
    <div className="var-editor-body" role="region" aria-label="项目声音预设" data-audio-presets>
      <div className="var-editor-toolbar"><p className="var-help">为人物和旁白保存常用声源；每段可继承、单独覆盖或明确不用。</p>{onImportAudio && <button type="button" className="btn small" aria-label="项目声音预设导入音频" disabled={disabled || importing} onClick={() => { void importAudio(); }}>{importing ? '导入中…' : '导入音频'}</button>}</div>
      {importError && <p className="var-warning" role="alert">{importError}</p>}
      <div className="var-preset-list">{rows.map(({ id, name, target, preset }) => {
        const asset = assets.find((item) => item.id === preset?.assetId);
        return <div className="var-preset-row" key={`${target.kind}-${id}`} role="group" aria-label={`${name}声音预设`}>
          <strong title={videoAudioTargetLabel(project, target)}>{name}</strong>
          <label className="field"><span>默认音频</span><AudioAssetSelect assets={assets} assetId={preset?.assetId || ''} label={`${name}声音预设音频`} disabled={disabled} onChange={(assetId) => setPreset(target, assetId ? { ...preset, assetId, retainMode: preset?.retainMode || 'reference' } : undefined)} /></label>
          <label className="field"><span>参考方式</span><select aria-label={`${name}声音预设保留方式`} value={preset?.retainMode || 'reference'} disabled={disabled || !preset} onChange={(event) => preset && setPreset(target, { ...preset, retainMode: event.target.value as AudioRetainMode })}>
            {audioRetainModes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select></label>
          <AudioPreview media={asset} label={`${name}声音预设试听`} />
          {preset && (!asset || asset.missing) && <p className="var-warning">预设音频不可用，请重新选择。</p>}
        </div>;
      })}</div>
    </div>
  </details>;
}
