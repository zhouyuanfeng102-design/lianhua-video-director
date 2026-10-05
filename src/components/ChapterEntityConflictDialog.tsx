import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ChapterEntityCatalog, ChapterEntityConflict } from '../chapterEntities';
import type { StoryAnalysisResponse } from '../services/llm';

export interface ChapterEntityResolution { kind: ChapterEntityConflict['kind']; name: string; existingEntityId?: string; newName?: string }

function ConflictDialog({ conflicts, catalog, finish }: {
  conflicts: ChapterEntityConflict[];
  catalog: ChapterEntityCatalog;
  finish: (value: ChapterEntityResolution[] | null) => void;
}) {
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [names, setNames] = useState<Record<number, string>>({});
  const records = (kind: ChapterEntityConflict['kind']) => catalog[kind === 'character' ? 'characters' : kind === 'location' ? 'locations' : 'props'];
  const complete = conflicts.every((conflict, index) => choices[index] && (choices[index] !== '__new__'
    || names[index]?.trim() && !records(conflict.kind).some((entry) => entry.name === names[index].trim() || entry.aliases.includes(names[index].trim()))));
  return <div className="modal-backdrop" style={{ position: 'fixed', inset: 0, zIndex: 10000, display: 'grid', placeItems: 'center', background: '#0007' }}>
    <section role="dialog" aria-modal="true" aria-labelledby="chapter-entity-dialog-title" style={{ background: 'white', padding: 24, borderRadius: 14, width: 'min(760px, 92vw)', maxHeight: '85vh', overflowY: 'auto', color: '#292732' }}>
      <h2 id="chapter-entity-dialog-title">确认本章资料关联</h2>
      <p>以下名称对应关系不明确。选择已有资料，或为本章新资料填写不同的名称；已有资料内容会保留。</p>
      {conflicts.map((conflict, index) => <div key={`${conflict.kind}-${conflict.name}`} style={{ padding: '14px 0', borderTop: '1px solid #ddd' }}>
        <strong>{conflict.name}</strong><p>{conflict.reason}</p>
        <select aria-label={`${conflict.name}关联资料`} value={choices[index] || ''} onChange={(event) => setChoices({ ...choices, [index]: event.target.value })} style={{ width: '100%', padding: 10 }}>
          <option value="">请选择</option>
          {records(conflict.kind).filter((entry) => !conflict.candidateIds.length || conflict.candidateIds.includes(entry.id)).map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.description || entry.id}</option>)}
          <option value="__new__">另建资料（填写新名称）</option>
        </select>
        {choices[index] === '__new__' && <input aria-label={`${conflict.name}新资料名称`} value={names[index] || ''} placeholder="填写可区分的新名称或具体形态名称" onChange={(event) => setNames({ ...names, [index]: event.target.value })} style={{ width: '100%', padding: 10, marginTop: 8 }} />}
      </div>)}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 20 }}>
        <button className="btn" onClick={() => finish(null)}>取消解析</button>
        <button className="btn primary" disabled={!complete} onClick={() => finish(conflicts.map((conflict, index) => ({ kind: conflict.kind, name: conflict.name,
          ...(choices[index] === '__new__' ? { newName: names[index].trim() } : { existingEntityId: choices[index] }),
        })))}>确认关联并继续</button>
      </div>
    </section>
  </div>;
}

/** Isolated dialog lifetime follows the request; cancelling never mutates a project. */
export const askChapterEntityResolutions = (
  conflicts: ChapterEntityConflict[], catalog: ChapterEntityCatalog, signal?: AbortSignal,
): Promise<ChapterEntityResolution[] | null> => {
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const finish = (value: ChapterEntityResolution[] | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', aborted);
      root.unmount(); host.remove(); resolve(value);
    };
    const aborted = () => finish(null);
    signal?.addEventListener('abort', aborted, { once: true });
    root.render(<ConflictDialog conflicts={conflicts} catalog={catalog} finish={finish} />);
  });
};

export const applyChapterEntityResolutions = (analysis: StoryAnalysisResponse, resolutions: ChapterEntityResolution[], catalog: ChapterEntityCatalog): StoryAnalysisResponse => {
  const update = (value: unknown, kind: ChapterEntityConflict['kind']) => {
    const raw = typeof value === 'string' ? { name: value } : value as Record<string, unknown>;
    const resolution = resolutions.find((item) => item.kind === kind && item.name === raw?.name);
    if (!resolution) return value;
    const record = catalog[kind === 'character' ? 'characters' : kind === 'location' ? 'locations' : 'props'].find((entry) => entry.id === resolution.existingEntityId);
    return resolution.newName ? { ...raw, name: resolution.newName, aliases: [], existingEntityId: undefined }
      : { ...raw, name: record?.name || raw.name, existingEntityId: resolution.existingEntityId,
        ...(kind === 'character' ? { formLabel: record?.formLabel, baseName: record?.baseName } : {}),
      };
  };
  return {
    ...analysis,
    characters: analysis.characters?.map((value) => update(value, 'character')),
    locations: analysis.locations?.map((value) => update(value, 'location')),
    props: analysis.props?.map((value) => update(value, 'prop')),
    scenes: analysis.scenes.map((scene) => ({ ...scene,
      characters: scene.characters?.map((value) => update(value, 'character')),
      location: scene.location ? update(scene.location, 'location') : undefined,
      props: scene.props?.map((value) => update(value, 'prop')),
    })),
  } as StoryAnalysisResponse;
};
