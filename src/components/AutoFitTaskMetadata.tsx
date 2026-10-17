import { useLayoutEffect, useRef, type ReactNode } from 'react';

/** Keep image-task details inside the space left below the unchanged title. */
export function AutoFitTaskMetadata({ children }: { children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    let frame = 0;
    let disposed = false;
    const measure = () => {
      frame = 0;
      if (disposed || !viewport.clientWidth || !viewport.clientHeight) return;
      const scale = Number.parseFloat(getComputedStyle(viewport).getPropertyValue('--ui-font-scale')) || 1;
      let lower = 7 * scale;
      let upper = 9 * scale;
      const fits = (size: number) => {
        content.style.fontSize = `${size}px`;
        return content.getBoundingClientRect().height <= viewport.clientHeight
          && content.scrollWidth <= viewport.clientWidth;
      };
      if (!fits(upper)) {
        // A bounded search preserves the largest readable size that fits.
        // Extreme histories remain accessible by scrolling at the minimum size.
        for (let step = 0; step < 7; step += 1) {
          const middle = (lower + upper) / 2;
          if (fits(middle)) lower = middle;
          else upper = middle;
        }
        content.style.fontSize = `${lower}px`;
      }
    };
    const schedule = () => {
      if (!disposed && !frame) frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(viewport);
    const mutations = new MutationObserver(schedule);
    mutations.observe(content, { childList: true, characterData: true, subtree: true });
    const shell = viewport.closest('.app-shell');
    if (shell) mutations.observe(shell, { attributes: true, attributeFilter: ['style', 'data-ui-font-scale'] });
    document.fonts?.addEventListener('loadingdone', schedule);
    void document.fonts?.ready.then(schedule);
    measure();
    return () => {
      disposed = true;
      resize.disconnect();
      mutations.disconnect();
      document.fonts?.removeEventListener('loadingdone', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return <div ref={viewportRef} className="image-task-metadata" role="region" aria-label="本次图片任务详情" tabIndex={0}>
    <div ref={contentRef} className="image-task-metadata-content">{children}</div>
  </div>;
}
