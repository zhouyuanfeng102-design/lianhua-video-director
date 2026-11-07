import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Clapperboard, FolderOpen, Images, ListVideo, Menu, Settings, X } from 'lucide-react';
import type { ViewKey } from '../types';
import { isMobileAppViewport } from '../appViewportFit';
import { isAndroidRuntime } from '../platform/runtime';

/** Mobile uses its own flow layout. Desktop window fitting must never shrink
 * a phone-sized viewport or a native Android landscape window. */
export function useMobileAppLayout() {
  const read = () => isMobileAppViewport(window.innerWidth, window.innerHeight,
    isAndroidRuntime(), window.matchMedia('(pointer: coarse)').matches);
  const [mobile, setMobile] = useState(read);
  useLayoutEffect(() => {
    let largestHeight = window.innerHeight;
    let lastWidth = window.innerWidth;
    const update = () => {
      const next = read();
      setMobile(next);
      document.documentElement.dataset.mobileLayout = String(next);
      const viewport = window.visualViewport;
      const visibleHeight = viewport?.height || window.innerHeight;
      if (Math.abs(window.innerWidth - lastWidth) > 100) largestHeight = window.innerHeight;
      lastWidth = window.innerWidth;
      largestHeight = Math.max(largestHeight, window.innerHeight);
      document.documentElement.style.setProperty('--mobile-viewport-height', `${visibleHeight}px`);
      const focused = document.activeElement;
      const editing = focused instanceof HTMLElement && focused.matches('input:not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true]');
      document.documentElement.dataset.mobileKeyboard = String(next && editing && largestHeight - visibleHeight > 120);
    };
    const reveal = () => {
      update();
      if (!read()) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.matches('input, textarea, [contenteditable=true]')) {
        requestAnimationFrame(() => focused.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
      }
    };
    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', reveal);
    document.addEventListener('focusin', reveal);
    document.addEventListener('focusout', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', reveal);
      document.removeEventListener('focusin', reveal);
      document.removeEventListener('focusout', update);
      delete document.documentElement.dataset.mobileLayout;
      delete document.documentElement.dataset.mobileKeyboard;
    };
  }, []);
  return mobile;
}

const creationViews: ViewKey[] = ['story', 'storyboard', 'director', 'video'];
const creationSteps: { view: ViewKey; label: string }[] = [
  { view: 'story', label: '剧情' }, { view: 'storyboard', label: '分镜' }, { view: 'director', label: '提示词' },
];

interface MobileAppNavigationProps {
  view: ViewKey;
  title: string;
  projectName: string;
  navigation: { key: ViewKey; label: string; icon: ReactNode }[];
  onNavigate: (view: ViewKey) => void;
  onProjects: () => void;
  actions: ReactNode;
  notice?: ReactNode;
  children: ReactNode;
}

/** Layout only: every destination and action is the existing App handler. */
export function MobileAppNavigation({ view, title, projectName, navigation, onNavigate, onProjects, actions, notice, children }: MobileAppNavigationProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const history = useRef<ViewKey[]>([]);
  const lastView = useRef(view);
  const lastCreation = useRef<ViewKey>('story');
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuDialog = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    document.querySelector('.mobile-shell .workspace')?.scrollTo({ top: 0, left: 0 });
  }, [view]);
  useEffect(() => {
    if (view !== lastView.current) {
      history.current.push(lastView.current);
      if (history.current.length > 30) history.current.shift();
      lastView.current = view;
    }
    if (creationViews.includes(view)) lastCreation.current = view;
    setMenuOpen(false);
  }, [view]);
  useEffect(() => {
    if (!menuOpen) return;
    const first = menuDialog.current?.querySelector<HTMLButtonElement>('button');
    first?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); menuButton.current?.focus(); }
      if (event.key !== 'Tab') return;
      const items = [...(menuDialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]') || [])].filter(item => item.getClientRects().length > 0);
      const firstItem = items[0]; const lastItem = items[items.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) { event.preventDefault(); lastItem?.focus(); }
      else if (!event.shiftKey && document.activeElement === lastItem) { event.preventDefault(); firstItem?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [menuOpen]);
  useEffect(() => {
    const back = (event: Event) => {
      const handled = () => {
        event.preventDefault();
        if (event instanceof CustomEvent && event.detail) event.detail.handled = true;
      };
      if (menuOpen) { setMenuOpen(false); handled(); return; }
      const chapterActions = document.querySelector<HTMLDetailsElement>('.mobile-chapter-actions[open]');
      if (chapterActions) { chapterActions.open = false; handled(); return; }
      const dialogs = [...document.querySelectorAll<HTMLElement>('[role=dialog], [role=alertdialog], .modal, .vd-modal, .chapter-dialog')].filter(dialog => dialog.getClientRects().length > 0);
      const dialog = dialogs[dialogs.length - 1];
      if (dialog) {
        const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const close = buttons.find(button => /^(关闭|取消|返回)$/.test((button.textContent || '').trim()) || /^(关闭|返回)/.test(button.getAttribute('aria-label') || ''));
        if (close) close.click();
        else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        handled(); return;
      }
      const previous = history.current.pop();
      if (previous) {
        lastView.current = previous;
        onNavigate(previous); handled();
      } else if (view !== 'dashboard') { onNavigate('dashboard'); handled(); }
    };
    window.addEventListener('lianhua:backbutton', back);
    return () => window.removeEventListener('lianhua:backbutton', back);
  }, [menuOpen, onNavigate, view]);

  const navigate = (next: ViewKey) => { setMenuOpen(false); onNavigate(next); };
  const next = view === 'story' ? { view: 'director' as ViewKey, label: '进入提示词导演台' }
    : view === 'storyboard' ? { view: 'director' as ViewKey, label: '打开提示词' }
    : view === 'director' ? { view: 'video' as ViewKey, label: '打开视频导演台' } : undefined;

  return <>
    <header className="mobile-header">
      <button ref={menuButton} type="button" className="mobile-icon-button" aria-label="全部功能" aria-expanded={menuOpen} aria-controls="mobile-app-menu" onClick={() => setMenuOpen(true)}><Menu size={22} /></button>
      <div className="mobile-header-copy"><strong>{title}</strong><button type="button" className="mobile-project-picker" onClick={onProjects} aria-label={`当前项目：${projectName}，打开项目库`}>{projectName}</button></div>
      <button type="button" className="mobile-icon-button" aria-label="打开 API 设置" onClick={() => navigate('settings')}><Settings size={22} /></button>
    </header>
    {creationViews.includes(view) && <nav className="mobile-creation-steps" aria-label="创作步骤">{creationSteps.map((step, index) => <button key={step.view} type="button" aria-current={view === step.view ? 'step' : undefined} onClick={() => navigate(step.view)}><span>{index + 1}</span>{step.label}</button>)}</nav>}
    {notice && <div className="mobile-notice" role="status">{notice}</div>}
    {view === 'video-workbench' && isAndroidRuntime() && <p className="mobile-native-media-note" role="note">Android 支持裁剪、拼接与声音输出。当前不支持交叉淡化；含交叉淡化的方案请在桌面版导出。</p>}
    {children}
    {next && <div className="mobile-action-dock"><span>继续创作</span><button type="button" className="btn primary" onClick={() => navigate(next.view)}>{next.label}<ArrowRight size={18} /></button></div>}
    <nav className="mobile-bottom-nav" aria-label="手机主导航">
      <button type="button" aria-current={view === 'dashboard' ? 'page' : undefined} onClick={() => navigate('dashboard')}><FolderOpen size={21} /><span>项目</span></button>
      <button type="button" aria-current={creationViews.includes(view) ? 'page' : undefined} onClick={() => navigate(lastCreation.current)}><Clapperboard size={21} /><span>创作</span></button>
      <button type="button" aria-current={view === 'assets' || view === 'image' ? 'page' : undefined} onClick={() => navigate('assets')}><Images size={21} /><span>素材</span></button>
      <button type="button" aria-current={view === 'jobs' ? 'page' : undefined} onClick={() => navigate('jobs')}><ListVideo size={21} /><span>任务</span></button>
    </nav>
    {menuOpen && <div className="mobile-menu-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setMenuOpen(false); }}>
      <div id="mobile-app-menu" className="mobile-menu-panel" role="dialog" aria-modal="true" aria-labelledby="mobile-menu-title" ref={menuDialog}>
        <header><h2 id="mobile-menu-title">全部功能</h2><button type="button" className="mobile-icon-button" aria-label="关闭全部功能" onClick={() => { setMenuOpen(false); menuButton.current?.focus(); }}><X size={22} /></button></header>
        <nav aria-label="全部工作区">{navigation.map(item => <button type="button" key={item.key} aria-current={view === item.key ? 'page' : undefined} onClick={() => navigate(item.key)}>{item.icon}<span>{item.label}</span><ArrowRight size={17} /></button>)}</nav>
        <div className="mobile-menu-actions" onClick={event => { if ((event.target as HTMLElement).closest('button, label.btn')) setMenuOpen(false); }}>{actions}</div>
        <button type="button" className="btn" onClick={() => { setMenuOpen(false); onProjects(); }}><FolderOpen size={18} />打开项目库</button>
        <button type="button" className="btn" onClick={() => setMenuOpen(false)}><ArrowLeft size={18} />返回当前页面</button>
      </div>
    </div>}
  </>;
}
