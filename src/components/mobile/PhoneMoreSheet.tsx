import type { ReactNode } from "react";

export function PhoneMoreSheet({ onClose, entries, actions, onProjects }: {
  onClose: () => void;
  entries: { key: string; label: string; current: boolean; onClick: () => void }[];
  actions: ReactNode;
  onProjects: () => void;
}) {
  return (
    <div className="mobile-menu-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div id="mobile-app-menu" className="mobile-menu-panel phone-more-sheet" role="dialog" aria-modal="true" aria-labelledby="phone-more-title" >
        <header><h2 id="phone-more-title">更多</h2><button type="button" className="mobile-icon-button" aria-label="关闭" onClick={onClose}>关闭</button></header>
        <nav aria-label="更多功能">
          {entries.map((entry) => <button type="button" key={entry.key} aria-current={entry.current ? "page" : undefined} onClick={entry.onClick}><span>{entry.label}</span></button>)}
        </nav>
        <div className="mobile-menu-actions" onClick={(event) => { if ((event.target as HTMLElement).closest("button, label.btn")) onClose(); }}>{actions}</div>
        <button type="button" className="btn" onClick={onProjects}>打开项目库</button>
      </div>
    </div>
  );
}
