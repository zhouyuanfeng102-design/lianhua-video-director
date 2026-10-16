import { useEffect, useState } from 'react';
import type { Character, ReferenceAsset } from '../types';
import {
  CHARACTER_VOICE_PROFILE_FIELDS,
  normalizeCharacterVoiceProfile,
  updateCharacterVoiceProfile,
  type CharacterVoiceProfile,
  type CharacterVoiceProfileField,
} from '../characterVoiceProfile';
import { isVideoDirectorAudio } from '../videoAudioReferences';
import '../videoAudioReferences.css';

type VoiceDraft = Record<CharacterVoiceProfileField, string>;
const draftOf = (profile: CharacterVoiceProfile | undefined): VoiceDraft => Object.fromEntries(
  CHARACTER_VOICE_PROFILE_FIELDS.map((field) => [field, profile?.[field] || '']),
) as VoiceDraft;
const audioSource = (asset: ReferenceAsset | undefined): string => !asset || asset.missing ? ''
  : asset.dataUrl || asset.url || (asset.relativePath
    ? `lianhua-asset://local/${asset.relativePath.replace(/\\/gu, '/').split('/').map(encodeURIComponent).join('/')}` : '');

export interface CharacterVoiceProfileEditorProps {
  character: Character;
  assets: ReferenceAsset[];
  disabled?: boolean;
  onChange: (profile: CharacterVoiceProfile | undefined) => void;
}

/** Keep editing separate from committing so a revision represents a saved voice choice. */
export function CharacterVoiceProfileEditor({ character, assets, disabled = false, onChange }: CharacterVoiceProfileEditorProps) {
  const profile = normalizeCharacterVoiceProfile(character.voiceProfile);
  const profileKey = JSON.stringify(profile || null);
  const [draft, setDraft] = useState<VoiceDraft>(() => draftOf(profile));
  const [message, setMessage] = useState('');
  useEffect(() => {
    setDraft(draftOf(normalizeCharacterVoiceProfile(character.voiceProfile)));
    setMessage('');
  }, [character.id, profileKey]);
  const audioAssets = assets.filter(isVideoDirectorAudio);
  const selectedAudio = audioAssets.find((asset) => asset.id === draft.referenceAssetId);
  const source = audioSource(selectedAudio);
  const candidate = updateCharacterVoiceProfile(profile, { ...draft, source: profile?.source });
  const changed = JSON.stringify(candidate || null) !== profileKey;
  const edit = (field: CharacterVoiceProfileField, value: string) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setMessage('');
  };
  const save = () => {
    if (!changed) return;
    onChange(updateCharacterVoiceProfile(profile, { ...draft, source: 'manual' }));
    setMessage('声音档案已保存；后续生成将使用新档案。');
  };
  const fields: Array<{ field: Exclude<CharacterVoiceProfileField, 'referenceAssetId'>; label: string; placeholder: string; rows: number }> = [
    { field: 'perceivedAge', label: '声音年龄', placeholder: '例如：听感为18—22岁的年轻女性；未确认可留空', rows: 1 },
    { field: 'timbre', label: '基础音色', placeholder: '例如：清亮、轻盈，中高音区，咬字清楚', rows: 2 },
    { field: 'language', label: '对白语言', placeholder: '例如：普通话、英语；按需填写', rows: 1 },
    { field: 'accent', label: '口音', placeholder: '例如：标准普通话，无明显地域口音', rows: 1 },
    { field: 'style', label: '稳定说话习惯', placeholder: '例如：语速从容、气息轻；本句情绪由分镜决定', rows: 2 },
    { field: 'notes', label: '声音一致性补充', placeholder: '例如：愤怒时仍保持同一年轻声线，不压低成沙哑成熟音', rows: 2 },
  ];
  return <details className="project-voice-preset-editor character-voice-profile-editor">
    <summary>人物声音档案 <span>· {profile ? `已保存 V${profile.version}` : '待填写'}</span></summary>
    <div className="var-editor-body" role="region" aria-label={`${character.name}人物声音档案`}>
      <p className="var-help">声音年龄与外观年龄、真实年龄分别设置。只填写已确认的声音特征；基础音色保持稳定，本句的冷淡、愤怒等情绪由分镜描述。</p>
      <div className="var-slot-options">{fields.map(({ field, label, placeholder, rows }) => <label className="field" key={field}>
        <span>{label}</span><textarea aria-label={`${character.name}${label}`} rows={rows} value={draft[field]} disabled={disabled}
          placeholder={placeholder} onChange={(event) => edit(field, event.target.value)} />
      </label>)}</div>
      <label className="field"><span>候选样音（可选）</span>
        <select aria-label={`${character.name}候选样音`} value={draft.referenceAssetId} disabled={disabled} onChange={(event) => edit('referenceAssetId', event.target.value)}>
          <option value="">不选择样音</option>
          {draft.referenceAssetId && !selectedAudio && <option value={draft.referenceAssetId}>原样音已不存在</option>}
          {audioAssets.map((asset) => <option key={asset.id} value={asset.id} disabled={Boolean(asset.missing)}>{asset.name}{asset.missing ? ' · 文件缺失' : ''}</option>)}
        </select>
      </label>
      {source && <div className="var-audio-preview"><audio controls preload="none" src={source} aria-label={`${character.name}候选样音试听`} /></div>}
      {draft.referenceAssetId && (!selectedAudio || selectedAudio.missing) && <p className="var-warning">候选样音不可用，请重新选择。文字档案仍可保存。</p>}
      <p className="var-help">此处样音可供选声与试听。未另设项目声音预设时，支持音频的工作流会继承此样音；项目声音预设与本段覆盖优先，是否生效取决于所用接口支持。</p>
      <div className="var-editor-toolbar">
        <button type="button" className="btn small primary" disabled={disabled || !changed} onClick={save}>保存声音档案</button>
        <button type="button" className="btn small" disabled={disabled || (!profile && !CHARACTER_VOICE_PROFILE_FIELDS.some((field) => draft[field].trim()))}
          onClick={() => { setDraft(draftOf(undefined)); setMessage(''); if (profile) onChange(undefined); }}>清空声音档案</button>
      </div>
      {message && <p className="var-help" role="status">{message}</p>}
    </div>
  </details>;
}
