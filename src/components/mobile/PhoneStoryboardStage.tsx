import type { VideoShot } from "../../types";

export function PhoneStoryboardStage({ shots, selectedId, onSelect, onPatch, onBoundary, onLock, onRewrite }: {
  shots: VideoShot[];
  selectedId: string;
  onSelect: (shotId: string) => void;
  onPatch: (shotId: string, patch: Partial<VideoShot>) => void;
  onBoundary: (shotId: string, endSec: number) => void;
  onLock: (shotId: string) => void;
  onRewrite: (shotId: string) => void;
}) {
  const selected = shots.find((shot) => shot.id === selectedId) || shots[0];
  const next = selected ? shots[selected.index] : undefined;
  return (
    <div className="phone-step">
      <div className="phone-shot-strip" role="list">
        {shots.map((shot) => (
          <button key={shot.id} type="button" role="listitem" aria-current={selected?.id === shot.id ? "true" : undefined} onClick={() => onSelect(shot.id)}>
            <strong>第 {shot.index} 镜</strong>
            <span>{shot.startSec}–{shot.endSec}s</span>
          </button>
        ))}
      </div>
      {selected ? <div className="phone-shot-editor">
        <h2>第 {selected.index} 镜</h2>
        {next && <label>与下一镜切换点（秒）<input type="number" step={0.01} min={selected.startSec + 0.01} max={next.endSec - 0.01} value={selected.endSec} disabled={selected.locked || next.locked} onChange={(event) => onBoundary(selected.id, Number(event.target.value))} /></label>}
        {([
          ["subject", "主体"],
          ["action", "主动作"],
          ["camera", "镜头与运镜"],
          ["transition", "转场与连续性"],
          ["lighting", "光影"],
          ["sound", "声音"],
        ] as const).map(([key, label]) => (
          <label key={key}>{label}<textarea value={selected[key]} disabled={selected.locked} onChange={(event) => onPatch(selected.id, { [key]: event.target.value })} /></label>
        ))}
        <div className="phone-secondary-row">
          <button type="button" onClick={() => onLock(selected.id)}>{selected.locked ? "已锁定" : "锁定"}</button>
          <button type="button" onClick={() => onRewrite(selected.id)}>重写动作</button>
        </div>
      </div> : <p>这一段还没有镜头。</p>}
    </div>
  );
}
