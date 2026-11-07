import { useState } from "react";

export function PhoneStoryStep({ storyInput, setStoryInput, busy, storyExpansionBusy, onAnalyze, onSave, onOptimize, canRestore, onRestore, onClear, onEntities, onScenes }: {
  storyInput: string;
  setStoryInput: (value: string) => void;
  busy: boolean;
  storyExpansionBusy: boolean;
  onAnalyze: () => void;
  onSave: () => void;
  onOptimize: () => void;
  canRestore: boolean;
  onRestore: () => void;
  onClear: () => void;
  onEntities: () => void;
  onScenes: () => void;
}) {
  const [more, setMore] = useState(false);
  const blocked = !storyInput.trim() || busy || storyExpansionBusy;
  return (
    <div className="phone-step">
      <textarea className="phone-prompt-editor" aria-label="剧情原文" value={storyInput} onChange={(event) => setStoryInput(event.target.value)} placeholder="粘贴章节或一句话剧情" />
      <button type="button" className="phone-primary" disabled={blocked} onClick={onAnalyze}>{busy ? "解析中…" : "解析并补全"}</button>
      <div className="phone-secondary-row">
        <button type="button" onClick={onSave}>保存原文</button>
        <button type="button" aria-expanded={more} onClick={() => setMore((open) => !open)}>更多</button>
      </div>
      {more && <div className="phone-more-panel">
        <button type="button" disabled={blocked} onClick={onOptimize}>{storyExpansionBusy ? "转化中…" : "AI画面描述转化"}</button>
        {canRestore && <button type="button" onClick={onRestore}>还原处理前文本</button>}
        <button type="button" onClick={onClear}>清空</button>
        <button type="button" onClick={onEntities}>实体资料</button>
        <button type="button" onClick={onScenes}>场景管理</button>
      </div>}
    </div>
  );
}
