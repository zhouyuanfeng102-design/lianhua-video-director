import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { calculateSidebarFit } from '../sidebarFit';

/** Fit the navigation to its real remaining space. Only this subtree is
 * scaled; the workspace and the user's global font preference stay intact. */
export function AutoFitSidebarNav({ children }: { children: ReactNode }) {
  const navRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const nav = navRef.current;
    const content = contentRef.current;
    if (!nav || !content) return;
    let frame = 0;
    let disposed = false;
    const measure = () => {
      frame = 0;
      if (disposed || !nav.clientHeight || !nav.clientWidth) return;
      const available = nav.getBoundingClientRect();
      // One synchronous read/write transaction: measure at the same natural
      // size regardless of the previous scale, then commit before paint.
      // Dividing rounded offset sizes by the previous zoom caused a perpetual
      // ResizeObserver feedback loop at fractional DPI / short window sizes.
      content.style.setProperty('zoom', '1');
      content.style.height = 'auto';
      const naturalHeight = content.getBoundingClientRect().height;
      let requiredWidth = 1;
      for (const button of content.querySelectorAll<HTMLElement>('.nav-item')) {
        const label = button.querySelector<HTMLElement>('.nav-item-label');
        if (!label) continue;
        const range = document.createRange();
        range.selectNodeContents(label);
        const textWidth = range.getBoundingClientRect().width;
        requiredWidth = Math.max(requiredWidth,
          button.getBoundingClientRect().width - label.getBoundingClientRect().width + textWidth + 3);
      }
      const fit = calculateSidebarFit({
        availableWidth: available.width,
        availableHeight: available.height,
        naturalWidth: requiredWidth,
        naturalHeight,
      });
      if (!fit) return;
      content.style.setProperty('zoom', String(fit.scale));
      nav.dataset.fitScale = String(fit.scale);
      // CSS zoom keeps an auto-width block filling the physical sidebar.
      // The explicit native height leaves spare space above the utility links.
      content.style.height = `${fit.contentHeight}px`;
      nav.scrollTop = 0;
      nav.scrollLeft = 0;
    };
    const schedule = () => {
      if (!disposed && !frame) frame = window.requestAnimationFrame(measure);
    };
    // Only observe the externally allocated viewport. Observing the content
    // that this function itself scales re-triggers measurement on every fit.
    const observer = new ResizeObserver(schedule);
    observer.observe(nav);
    const mutations = new MutationObserver(schedule);
    mutations.observe(content, {
      childList: true, characterData: true, subtree: true,
      attributes: true, attributeFilter: ['class', 'hidden'],
    });
    const shell = nav.closest('.app-shell');
    if (shell) mutations.observe(shell, {
      attributes: true, attributeFilter: ['style', 'class', 'data-ui-font-scale'],
    });
    window.addEventListener('resize', schedule);
    document.fonts?.addEventListener('loadingdone', schedule);
    void document.fonts?.ready.then(schedule);
    measure();
    return () => {
      disposed = true;
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', schedule);
      document.fonts?.removeEventListener('loadingdone', schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return <nav ref={navRef} className="nav sidebar-nav-fit" aria-label="工作台导航" data-fit-scale="1">
    <div ref={contentRef} className="sidebar-nav-fit-content">{children}</div>
  </nav>;
}
