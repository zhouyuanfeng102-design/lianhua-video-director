import { useState, type ReactNode } from "react";

export function PhoneJobList({ tabs, rows }: {
  tabs: { key: string; label: string; current: boolean; onClick: () => void }[];
  rows: { id: string; title: string; status: string; time: string; reuse?: () => void; detail: ReactNode }[];
}) {
  const [openId, setOpenId] = useState("");
  const open = rows.find((row) => row.id === openId);
  return (
    <div className="phone-jobs">
      <div className="phone-chip-row">
        {tabs.map((tab) => <button key={tab.key} type="button" aria-pressed={tab.current} onClick={tab.onClick}>{tab.label}</button>)}
      </div>
      {rows.map((row) => (
        <article key={row.id} className="phone-job-row">
          <button type="button" onClick={() => setOpenId(row.id)}>
            <strong>{row.status}</strong>
            <span>{row.title}</span>
            <small>{row.time}</small>
          </button>
          {row.reuse && <button type="button" onClick={row.reuse}>载入相同设置再次生成</button>}
        </article>
      ))}
      {!rows.length && <p>这一类还没有任务。</p>}
      {open && <div className="phone-job-detail" role="dialog" aria-label="任务详情">
        <button type="button" className="phone-secondary" onClick={() => setOpenId("")}>关闭</button>
        {open.detail}
      </div>}
    </div>
  );
}
