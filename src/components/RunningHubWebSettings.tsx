import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Globe, RefreshCw } from 'lucide-react';
import {
  createRunningHubWebApp, isRunningHubWebAppReady, mergeRunningHubWebRead, removeRunningHubWebAccount,
  type RunningHubWebBind, type RunningHubWebConfig, type RunningHubWebField,
} from '../runningHubWeb';
import { formatUserFacingError } from '../userFacingError';
import { isAndroidRuntime } from '../platform/runtime';

export interface RunningHubWebSettingsProps {
  config: RunningHubWebConfig;
  getCurrentConfig?: () => RunningHubWebConfig;
  onChange: (next: RunningHubWebConfig) => void;
}

const bindLabel: Record<RunningHubWebBind, string> = {
  prompt: '完整视频提示词',
  idea: '短想法',
  image: '参考图槽',
  audio: '参考音频槽',
  duration: '时长',
  aspect_ratio: '比例',
  megapixels: '百万像素',
  fixed: '固定为当前值',
};

const bindsFor = (field: RunningHubWebField): RunningHubWebBind[] => {
  if (field.kind === 'image') return ['image', 'fixed'];
  if (field.kind === 'audio') return ['audio', 'fixed'];
  if (field.kind === 'text') return ['prompt', 'idea', 'fixed'];
  if (field.kind === 'number') return ['duration', 'megapixels', 'fixed'];
  if (field.kind === 'select') return ['aspect_ratio', 'fixed'];
  return ['fixed'];
};

const idFor = () => `rh-web-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

export function RunningHubWebSettings({ config, getCurrentConfig, onChange }: RunningHubWebSettingsProps) {
  const current = () => getCurrentConfig?.() || config;
  const [address, setAddress] = useState('https://www.runninghub.ai/zh-cn/ai-detail/2104753059472990209');
  const [accountName, setAccountName] = useState('');
  const [accountSite, setAccountSite] = useState<'ai' | 'cn'>('ai');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [watching, setWatching] = useState('');
  const [managerOpen, setManagerOpen] = useState(false);
  const autoNamed = useRef('');
  const autoAccount = useRef('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [managerTab, setManagerTab] = useState<'prompt' | 'image' | 'audio' | 'parameter'>('prompt');
  const apply = (next: RunningHubWebConfig) => { onChange(next); setError(''); };
  const account = config.accounts.find((item) => item.id === config.activeAccountId) || config.accounts[0];
  const app = config.apps.find((item) => item.id === config.activeAppId);
  const desktop = typeof window !== 'undefined' ? window.lianhuaDesktop : undefined;

  const rememberSession = (accountId: string, result: { open?: boolean; loggedIn?: boolean; displayName?: string; coins?: string; wallet?: string }) => {
    if (!result.open && result.loggedIn !== true) return;
    const live = current();
    const displayName = result.displayName?.trim() || '';
    apply({ ...live, accounts: live.accounts.map((item) => item.id === accountId ? {
      ...item,
      ...(result.loggedIn && displayName ? { name: displayName } : {}),
      session: {
        loggedIn: result.loggedIn === true,
        displayName,
        coins: result.coins || '',
        wallet: result.wallet || '',
        checkedAt: Date.now(),
      },
    } : item) });
  };
  const refreshSession = async (accountId: string) => {
    if (!desktop?.rhWebControl) return;
    const target = current().accounts.find((item) => item.id === accountId);
    if (!target) return;
    try {
      const result = await desktop.rhWebControl({ action: 'session', accountId, site: target.site });
      rememberSession(accountId, result);
      if (result.loggedIn) setWatching('');
    } catch { /* The window can close between checks. The last shown identity stays. */ }
  };
  useEffect(() => {
    if (busy || !account?.session?.loggedIn || account.session.displayName) return;
    if (autoAccount.current === account.id) return;
    autoAccount.current = account.id;
    void refreshSession(account.id);
  }, [account?.id, account?.session?.loggedIn, account?.session?.displayName, busy]);
  const login = async () => {
    if (!account) return;
    if (!desktop?.rhWebControl) { setError(isAndroidRuntime() ? '手机隔离网页登录尚未连接，请重新打开应用。' : '登录窗口只在桌面程序里打开。'); return; }
    setBusy(true); setError('');
    setMessage(`正在打开「${account.name} · ${account.site === 'cn' ? '国内站' : '国际站'}」的登录窗口。`);
    try {
      const result = await desktop.rhWebControl({ action: 'login', accountId: account.id, site: account.site });
      rememberSession(account.id, result);
      setWatching(account.id);
      setMessage(result.loggedIn
        ? `「${account.name}」已登录${result.displayName ? `：${result.displayName}` : ''}${result.coins ? `，${result.coins}` : ''}。`
        : `登录窗口已打开，当前是「${account.name} · ${account.site === 'cn' ? '国内站' : '国际站'}」。在窗口里登录后，这里会显示网页上的昵称和 RH 币。`);
    } catch (cause) { setError(formatUserFacingError(cause)); }
    finally { setBusy(false); }
  };
  const removeAccount = async () => {
    if (!account) return;
    const target = current().accounts.find((item) => item.id === account.id);
    if (!target) return;
    setBusy(true); setError('');
    try {
      if (desktop?.rhWebControl) await desktop.rhWebControl({ action: 'forget', accountId: target.id, site: target.site });
      if (watching === target.id) setWatching('');
      const live = current();
      if (!live.accounts.some((item) => item.id === target.id)) return;
      apply(removeRunningHubWebAccount(live, target.id));
      setConfirmingDelete(false);
      setMessage(`已删除登录位「${target.session?.displayName || target.name}」。网页应用和成片还在，RunningHub 网站上的账号也还在。`);
    } catch (cause) { setError(formatUserFacingError(cause)); }
    finally { setBusy(false); }
  };
  const refreshRef = useRef(refreshSession);
  refreshRef.current = refreshSession;
  useEffect(() => {
    if (!watching) return undefined;
    const timer = window.setInterval(() => { void refreshRef.current(watching); }, 2000);
    return () => window.clearInterval(timer);
  }, [watching]);

  const readPage = async () => {
    const live = current();
    const selected = live.apps.find((item) => item.id === live.activeAppId);
    const selectedAccount = live.accounts.find((item) => item.id === (selected?.accountId || live.activeAccountId)) || live.accounts[0];
    if (!selected || !selectedAccount) { setError('请先添加应用页。'); return; }
    if (!desktop?.rhWebControl) { setError(isAndroidRuntime() ? '手机隔离网页尚未连接，请重新打开应用。' : '读取网页只在桌面程序里进行。'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await desktop.rhWebControl({ action: 'read', accountId: selectedAccount.id, site: selected.site, url: selected.url });
      const fields = (result.fields || []).map((item) => ({ ...item, bind: item.bind || 'fixed' }));
      const latest = current();
      const target = latest.apps.find((item) => item.id === selected.id) || selected;
      apply({ ...latest, apps: latest.apps.map((item) => item.id === selected.id ? mergeRunningHubWebRead(target, { fields, instance: result.instance, estimate: result.estimate, name: result.name }) : item) });
      setMessage(result.fields?.length ? `已在后台读到 ${result.fields.length} 个字段${result.name ? `，应用名是「${result.name}」` : ''}。没有打开网页窗口。原有绑定按字段名保留。` : '网页没有返回字段。');
    } catch (cause) { setError(formatUserFacingError(cause)); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (!managerOpen || busy || !app || !/^网页应用 \d+$/u.test(app.name)) return;
    if (autoNamed.current === app.id) return;
    autoNamed.current = app.id;
    void readPage();
  }, [managerOpen, app?.id, app?.name, busy]);

  return <div className="vgs-main runninghub-video-settings" data-runninghub-web-settings="true">
    <section className="vgs-card">
      <div className="vgs-card-title rhv-connection-title">
        <div className="rhv-connection-heading"><h3><Globe size={16} /> RH 网页</h3></div>
        <label className="rhv-enable"><input type="checkbox" aria-label="启用 RH 网页" checked={config.enabled} onChange={(event) => apply({ ...current(), enabled: event.target.checked })} />启用 RH 网页</label>
      </div>
      {account && <div className="vgs-workflow-summary" aria-live="polite">
        <strong>{account.name} · {account.site === 'cn' ? '国内站' : '国际站'}</strong>
        {account.session?.loggedIn
          ? <span>已登录{account.session.coins ? ` · ${account.session.coins}` : ''}{account.session.wallet ? ` · ${account.session.wallet}` : ''}</span>
          : <span>尚未登录</span>}
        {watching === account.id && !account.session?.loggedIn && <span>登录窗口开着</span>}
      </div>}
      {!account && <div className="vgs-workflow-summary"><strong>还没有登录位</strong></div>}
      <div className="vgs-workflow-row">
        <label className="field"><span>登录位</span>
          <select aria-label="RH 网页账号" value={account?.id || ''} onChange={(event) => { setWatching(''); setConfirmingDelete(false); apply({ ...current(), activeAccountId: event.target.value }); }}>
            {config.accounts.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.site === 'cn' ? '国内站' : '国际站'}{item.session?.loggedIn ? ' · 已登录' : ''}</option>)}
          </select>
        </label>
        <div className="vgs-actions rh-web-login-actions">
          {confirmingDelete ? <>
            <button type="button" className="btn danger" disabled={busy || !account} onClick={() => void removeAccount()}>确认删除</button>
            <button type="button" className="btn" disabled={busy} onClick={() => { setConfirmingDelete(false); setMessage(''); }}>取消</button>
          </> : <>
            <button type="button" className="btn" disabled={busy || !account} onClick={() => void login()}>{isAndroidRuntime() ? '隔离网页登录' : '登录'}</button>
            <button type="button" className="btn" disabled={busy || !account || !desktop?.rhWebControl} onClick={() => account && void refreshSession(account.id)}>刷新</button>
            <button type="button" className="btn danger" disabled={busy || !account} onClick={() => { if (!account) return; setConfirmingDelete(true); setError(''); setMessage(`将删除「${account.name}」。网站上的账号、网页应用和成片保留。`); }}>删除</button>
          </>}
        </div>
      </div>
      <div className="rh-web-account-add">
        <label className="field"><span>新登录位</span><input aria-label="新登录位名称" value={accountName} placeholder="临时名字，登录后改为昵称" onChange={(event) => setAccountName(event.target.value)} /></label>
        <label className="field"><span>站点</span><select aria-label="新登录位站点" value={accountSite} onChange={(event) => setAccountSite(event.target.value as 'ai' | 'cn')}><option value="ai">国际站</option><option value="cn">国内站</option></select></label>
        <button type="button" className="btn" onClick={() => {
          const name = accountName.trim();
          if (!name) { setError('可以先写一个临时名字。登录成功后会改成网页上的昵称。'); return; }
          const live = current();
          const created = { id: idFor(), name, site: accountSite };
          const apps = live.apps.map((item) => live.accounts.some((entry) => entry.id === item.accountId) ? item : { ...item, accountId: created.id });
          setAccountName('');
          apply({ ...live, accounts: [...live.accounts, created], activeAccountId: created.id, apps });
          setMessage(`已添加「${name}」。点「登录」打开网页。`);
        }}>添加</button>
      </div>
    </section>
    <section className="vgs-card">
      <div className="vgs-card-title"><h3>RH 网页应用库</h3><span>{config.apps.length} 个已保存</span></div>
      <div className="vgs-workflow-row">
        <label className="field"><span>当前网页应用</span>
          <select aria-label="当前 RH 网页应用" value={app?.id || ''} onChange={(event) => apply({ ...current(), activeAppId: event.target.value || null })}>
            <option value="">未选择</option>
            {config.apps.map((item) => <option key={item.id} value={item.id}>{item.name}{isRunningHubWebAppReady(item) ? '' : ' · 待读取'}</option>)}
          </select>
        </label>
        <button type="button" className="btn" onClick={() => { setAddress(app?.url || address); setManagerOpen(true); }}><FolderOpen size={16} />管理网页应用</button>
      </div>
      <div className="vgs-workflow-summary"><strong>当前实际生效：</strong><span>{app?.name || '尚未选择'}</span>{app && <span className="vgs-summary-tags">提示词 {app.fields.filter((field) => field.kind === 'text').length} 个 · 图片槽 {app.fields.filter((field) => field.kind === 'image').length} 个 · 音频槽 {app.fields.filter((field) => field.kind === 'audio').length} 个</span>}</div>
    </section>
    <p className={`rhv-main-note${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>{error || message || '在管理页核对提示词、图片槽和参数。保存配置不点击运行，也不扣 RH 币。'}</p>
    {managerOpen && <div className="vwm-backdrop rhv-backdrop">
      <section className="vwm-dialog rhv-manager rh-web-manager" role="dialog" aria-modal="true" aria-label="RH 网页应用管理">
        <header className="vwm-header"><div><h2>RH 网页应用管理</h2><p>读取网页表单 · 绑定提示词、图片槽和参数 · 这里只配置，不提交任务</p></div><button type="button" className="btn" aria-label="关闭 RH 网页应用管理" onClick={() => setManagerOpen(false)}>关闭</button></header>
        <div className="vwm-body">
          <aside className="vwm-library">
            <div className="vwm-library-heading"><h3>应用库</h3><span>{config.apps.length} 个</span></div>
            <div className="vwm-library-list">{config.apps.map((item) => <button type="button" key={item.id} className={`vwm-library-item${item.id === app?.id ? ' selected' : ''}`} onClick={() => { setAddress(item.url); apply({ ...current(), activeAppId: item.id }); }}><strong>{item.name}</strong><span>{item.id === app?.id ? '当前使用' : isRunningHubWebAppReady(item) ? '可用' : '待读取'}</span></button>)}{!config.apps.length && <p className="vwm-empty">还没有应用。在右侧粘贴应用页链接。</p>}</div>
          </aside>
          <main className="vwm-editor">
            <label className="field"><span>应用页链接或应用号</span><input aria-label="RH 网页应用地址" value={address} onChange={(event) => setAddress(event.target.value)} /></label>
            <div className="vgs-actions"><button type="button" className="btn small" onClick={() => {
              try {
                const live = current();
                const created = createRunningHubWebApp(address, live.activeAccountId || live.accounts[0]?.id || '', live.apps);
                apply({ ...live, apps: [...live.apps, created], activeAppId: created.id });
                setMessage(created.ready ? '已放入这一页上次读到的槽位。可以再点读取网页核对。' : '已添加应用。请登录后读取网页。');
              } catch (cause) { setError(formatUserFacingError(cause)); }
            }}>添加应用</button><button type="button" className="btn small" disabled={busy || !app} onClick={() => void readPage()}><RefreshCw size={14} />读取网页</button>{app && app.fields.length > 0 && !app.ready && <button type="button" className="btn small" onClick={() => { const live = current(); apply({ ...live, apps: live.apps.map((item) => item.id === app.id ? { ...item, ready: true, updatedAt: Date.now() } : item) }); setMessage('已确认这组字段，可以在导演台生成。'); }}>确认这些字段</button>}</div>
            {app && <div className="vgs-workflow-summary"><strong>{app.name}</strong>{app.estimate && <span>页面预估 {app.estimate}</span>}<span>机型 {app.instance}</span></div>}
            <div className="vwm-section-tabs" role="tablist" aria-label="网页字段类别">
              {([['prompt', '提示词'], ['image', '参考图片槽'], ['audio', '参考音频槽'], ['parameter', '其它参数']] as const).map(([value, label]) => <button type="button" role="tab" key={value} aria-selected={managerTab === value} className={managerTab === value ? 'active' : ''} onClick={() => setManagerTab(value)}>{label}</button>)}
            </div>
            {managerTab === 'parameter' && app && <label className="field"><span>运行机型</span><select aria-label="运行机型" value={app.instance} onChange={(event) => { const live = current(); apply({ ...live, apps: live.apps.map((item) => item.id === app.id ? { ...item, instance: event.target.value, updatedAt: Date.now() } : item) }); }}><option value="Standard">Standard</option><option value="Plus">Plus</option><option value="Ultra">Ultra</option></select></label>}
            <div className="vgs-fields">
              {(app?.fields || []).filter((field) => managerTab === 'image' ? field.kind === 'image' : managerTab === 'audio' ? field.kind === 'audio' : managerTab === 'prompt' ? field.kind === 'text' && (field.bind === 'prompt' || field.bind === 'idea' || field.label === '提示词' || field.label.includes('触发')) : field.kind !== 'image' && field.kind !== 'audio' && !(field.kind === 'text' && (field.bind === 'prompt' || field.bind === 'idea' || field.label === '提示词' || field.label.includes('触发')))).map((field) => <label className="field" key={field.key}><span>{field.label}</span>
                <select aria-label={`${field.label}绑定`} value={field.bind} onChange={(event) => {
                  const bind = event.target.value as RunningHubWebBind;
                  const live = current();
                  apply({ ...live, apps: live.apps.map((item) => item.id === app?.id ? { ...item, fields: item.fields.map((entry) => entry.key === field.key ? { ...entry, bind } : entry), updatedAt: Date.now() } : item) });
                }}>{bindsFor(field).map((bind) => <option key={bind} value={bind}>{bindLabel[bind]}</option>)}</select>
                {field.kind === 'boolean' ? <select aria-label={`${field.label}的值`} value={field.value === true ? 'true' : 'false'} onChange={(event) => {
                  const live = current();
                  const value = event.target.value === 'true';
                  apply({ ...live, apps: live.apps.map((item) => item.id === app?.id ? { ...item, fields: item.fields.map((entry) => entry.key === field.key ? { ...entry, value } : entry), updatedAt: Date.now() } : item) });
                }}><option value="true">开</option><option value="false">关</option></select>
                : field.kind === 'select' ? <select aria-label={`${field.label}的值`} value={String(field.value)} onChange={(event) => {
                  const live = current();
                  const value = event.target.value;
                  apply({ ...live, apps: live.apps.map((item) => item.id === app?.id ? { ...item, fields: item.fields.map((entry) => entry.key === field.key ? { ...entry, value } : entry), updatedAt: Date.now() } : item) });
                }}>{(field.options?.includes(String(field.value)) || !field.value ? field.options || [] : [String(field.value), ...(field.options || [])]).map((option) => <option key={option} value={option}>{option}</option>)}</select>
                : field.kind === 'number' ? <input aria-label={`${field.label}的值`} type="number" value={String(field.value)} onChange={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value)) return;
                  const live = current();
                  apply({ ...live, apps: live.apps.map((item) => item.id === app?.id ? { ...item, fields: item.fields.map((entry) => entry.key === field.key ? { ...entry, value } : entry), updatedAt: Date.now() } : item) });
                }} />
                : field.kind === 'text' ? <input aria-label={`${field.label}的值`} value={String(field.value)} onChange={(event) => {
                  const live = current();
                  const value = event.target.value;
                  apply({ ...live, apps: live.apps.map((item) => item.id === app?.id ? { ...item, fields: item.fields.map((entry) => entry.key === field.key ? { ...entry, value } : entry), updatedAt: Date.now() } : item) });
                }} />
                : null}
              </label>)}
              {app && !(app.fields.some((field) => managerTab === 'image' ? field.kind === 'image' : managerTab === 'audio' ? field.kind === 'audio' : managerTab === 'prompt' ? field.kind === 'text' : field.kind !== 'image' && field.kind !== 'audio')) && <p className="vwm-empty">这一类还没有字段。点读取网页后再绑定。</p>}
            </div>
            <p className="vwm-help">这里改过的时长、比例、百万像素、开关、LoRA 和机型会在生成时写进网页。绑到时长、比例、百万像素或短想法时，导演台这次如果另外填了，就用导演台的。图片和音频仍用本次选中的文件。关闭这个窗口不会点击运行。</p>
          </main>
        </div>
      </section>
    </div>}
  </div>;
}
