import { useState, type ReactNode } from "react";
import type { VideoShot } from "../../types";

export function PhoneDirectorStage({ shots, prompt, format, moreSettings, onCamera, generate }: {
  shots: VideoShot[];
  prompt: ReactNode;
  format: ReactNode;
  moreSettings: ReactNode;
  onCamera: (shotId: string, camera: string) => void;
  generate: ReactNode;
}) {
  const [shotId, setShotId] = useState(shots[0]?.id || "");
  const [more, setMore] = useState(false);
  const shot = shots.find((item) => item.id === shotId) || shots[0];
  return (
    <div className="phone-step phone-director">
      {format}
      <div className="phone-prompt-read phone-prompt-read" role="region" aria-label="视频提示词正文">{prompt}</div>
      <div className="phone-shot-list">
        {shots.map((item) => (
          <button key={item.id} type="button" onClick={() => setShotId(item.id)}>
            <strong>第 {item.index} 镜 · {item.startSec}–{item.endSec}s</strong>
            <span>{item.subject}</span>
            <small>{item.camera}</small>
          </button>
        ))}
      </div>
      {shot && <div className="phone-shot-sheet" role="dialog" aria-label={`第 ${shot.index} 镜`}>
        <h2>第 {shot.index} 镜</h2>
        <label>镜头与运镜
          <textarea className="phone-camera-editor" aria-label="镜头与运镜" value={shot.camera} onChange={(event) => onCamera(shot.id, event.target.value)} />
        </label>
      </div>}
      <button type="button" className="phone-secondary" aria-expanded={more} onClick={() => setMore((open) => !open)}>更多设置</button>
      {more && <div className="phone-more-panel">{moreSettings}</div>}
      <div className="phone-director-generate">{generate}</div>
    </div>
  );
}
