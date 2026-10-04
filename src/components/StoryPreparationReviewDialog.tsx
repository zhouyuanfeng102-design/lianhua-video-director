import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { StoryPreparationResult, StoryPreparationWarning } from '../storyPreparationReview';
import '../storyPreparationReview.css';

export interface StoryPreparationReviewDialogProps {
  original: string;
  result: StoryPreparationResult;
  stale: boolean;
  fontScalePercent?: number;
  onAdopt: () => void;
  onKeepOriginal: () => void;
  /** Hide the dialog without discarding the pending result. */
  onClose: () => void;
}

const WARNINGS_PER_PAGE = 2;
type ReviewTab = 'comparison' | 'warnings';

function DialogueDetail({ label, value }: {
  label: string;
  value: StoryPreparationWarning['expected'];
}) {
  return <div className="sr-review-detail">
    <strong>{label}</strong>
    <div className="sr-review-detail-text" tabIndex={0} aria-label={`${label}明细`}>
      {value ? <>
        <div className="sr-review-speaker">说话人：{value.speaker || '（未标明或未可靠识别）'}</div>
        <div className="sr-review-utterance">{value.utterance || '（未识别到台词文字）'}</div>
      </> : <span className="sr-review-muted">未识别到对应对白，请查看完整文本。</span>}
    </div>
  </div>;
}

/** The returned story is always plain, read-only text until the caller accepts it. */
export function StoryPreparationReviewDialog({
  original, result, stale, fontScalePercent = 100, onAdopt, onKeepOriginal, onClose,
}: StoryPreparationReviewDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const comparisonId = useId();
  const warningsId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const originalRef = useRef<HTMLTextAreaElement>(null);
  const resultRef = useRef<HTMLTextAreaElement>(null);
  const callbacksRef = useRef({ onClose });
  const mountedRef = useRef(true);
  callbacksRef.current = { onClose };
  const [tab, setTab] = useState<ReviewTab>('comparison');
  const [warningPage, setWarningPage] = useState(0);
  const [copyStatus, setCopyStatus] = useState('');
  const pageCount = Math.max(1, Math.ceil(result.warnings.length / WARNINGS_PER_PAGE));
  const currentPage = Math.min(warningPage, pageCount - 1);
  const pageWarnings = result.warnings.slice(currentPage * WARNINGS_PER_PAGE, (currentPage + 1) * WARNINGS_PER_PAGE);

  useEffect(() => {
    mountedRef.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const dialog = dialogRef.current;
    const isTopDialog = () => {
      const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')]
        .filter((element) => element.getClientRects().length > 0);
      return dialogs[dialogs.length - 1] === dialog;
    };
    const focusableElements = () => dialog ? [...dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled),textarea:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])',
    )].filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0) : [];
    dialog?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopDialog() || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        callbacksRef.current.onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusableElements();
      const first = elements[0];
      const last = elements[elements.length - 1];
      const active = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
        dialog?.focus({ preventScroll: true });
      } else if (!dialog?.contains(active) || active === dialog) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (isTopDialog() && event.target instanceof Node && !dialog?.contains(event.target)) {
        (focusableElements()[0] || dialog)?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      mountedRef.current = false;
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
      if (previous?.isConnected && (document.activeElement === document.body || dialog?.contains(document.activeElement))) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    setTab('comparison');
    setWarningPage(0);
    setCopyStatus('');
  }, [original, result]);

  const copyText = async (source: 'original' | 'result') => {
    const value = source === 'original' ? original : result.text;
    const label = source === 'original' ? '原文' : 'AI 返回';
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      if (mountedRef.current) setCopyStatus(`已复制${label}。`);
    } catch {
      if (!mountedRef.current) return;
      const textarea = source === 'original' ? originalRef.current : resultRef.current;
      textarea?.focus({ preventScroll: true });
      textarea?.select();
      setCopyStatus(`无法自动复制，已选中${label}，可按 Ctrl+C 复制。`);
    }
  };

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextTab = event.key === 'Home' ? 'comparison' : event.key === 'End' ? 'warnings'
      : tab === 'comparison' ? 'warnings' : 'comparison';
    setTab(nextTab);
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-review-tab="${nextTab}"]`)?.focus();
  };

  const dialog = <div className="sr-review-backdrop" style={{ '--ui-font-scale': fontScalePercent / 100 } as CSSProperties} onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div ref={dialogRef} className="sr-review-dialog" role="dialog" aria-modal="true"
      aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
      <header className="sr-review-header">
        <div className="sr-review-heading">
          <h2 id={titleId}>AI 剧情优化 · 结果审阅</h2>
          <p id={descriptionId}>{result.warnings.length
            ? '先核对原文与 AI 返回，再决定是否采用；当前原文尚未改动。'
            : '本地语义校验已关闭。请对照原文与 AI 返回决定是否采用；当前原文尚未改动。'}</p>
        </div>
        <button type="button" className="btn sr-review-later" onClick={onClose}>稍后查看</button>
      </header>

      <div className="sr-review-tabs" role="tablist" aria-label="剧情优化审阅视图">
        <button type="button" className="btn" role="tab" id={`${comparisonId}-tab`}
          data-review-tab="comparison" aria-selected={tab === 'comparison'} aria-controls={comparisonId}
          tabIndex={tab === 'comparison' ? 0 : -1} onClick={() => setTab('comparison')} onKeyDown={onTabKeyDown}>对照预览</button>
        <button type="button" className="btn" role="tab" id={`${warningsId}-tab`}
          data-review-tab="warnings" aria-selected={tab === 'warnings'} aria-controls={warningsId}
          tabIndex={tab === 'warnings' ? 0 : -1} onClick={() => setTab('warnings')} onKeyDown={onTabKeyDown}>核对提示（{result.warnings.length}）</button>
      </div>

      {stale && <p className="sr-review-stale" role="status">原文或当前项目已变化，此结果对应的是旧原文，不能覆盖当前编辑区。仍可查看、复制或保留原文。</p>}

      <div className="sr-review-content">
        {tab === 'comparison' ? <section className="sr-review-comparison" id={comparisonId} role="tabpanel" aria-labelledby={`${comparisonId}-tab`}>
          <div className="sr-review-text-pane">
            <div className="sr-review-pane-heading"><label htmlFor={`${comparisonId}-original`}>处理前原文</label>
              <button type="button" className="btn small" onClick={() => { void copyText('original'); }}>复制原文</button></div>
            <textarea ref={originalRef} id={`${comparisonId}-original`} aria-label="处理前原文" value={original} readOnly spellCheck={false} wrap="soft" />
          </div>
          <div className="sr-review-text-pane">
            <div className="sr-review-pane-heading"><label htmlFor={`${comparisonId}-result`}>AI 返回结果</label>
              <button type="button" className="btn small" onClick={() => { void copyText('result'); }}>复制AI结果</button></div>
            <textarea ref={resultRef} id={`${comparisonId}-result`} aria-label="AI 返回结果" value={result.text} readOnly spellCheck={false} wrap="soft" />
          </div>
        </section> : <section className="sr-review-warnings" id={warningsId} role="tabpanel" aria-labelledby={`${warningsId}-tab`}>
          {result.warnings.length ? <>
            <p className="sr-review-advisory">以下是自动识别的疑点，可能存在误判，并不表示结果不可用。请结合完整原文核对，仍可选择采用。</p>
            <div className="sr-review-warning-list" style={{ gridTemplateRows: `repeat(${pageWarnings.length}, minmax(0, 1fr))` }}>
              {pageWarnings.map((warning, index) => <article className="sr-review-warning-card" key={warning.id}>
                <div className="sr-review-warning-summary">
                  <strong>{warning.index !== undefined ? `第 ${warning.index} 条对白` : `核对提示 ${currentPage * WARNINGS_PER_PAGE + index + 1}`}</strong>
                  <p>{warning.message}</p>
                </div>
                {(warning.expected || warning.actual) && <div className="sr-review-warning-details">
                  <DialogueDetail label="原文识别" value={warning.expected} />
                  <DialogueDetail label="返回识别" value={warning.actual} />
                </div>}
              </article>)}
            </div>
            <div className="sr-review-pagination" aria-label="核对提示分页">
              <span>第 {currentPage + 1} / {pageCount} 页 · 共 {result.warnings.length} 条</span>
              <button type="button" className="btn small" disabled={currentPage === 0} onClick={() => setWarningPage(currentPage - 1)}>上一页</button>
              <button type="button" className="btn small" disabled={currentPage >= pageCount - 1} onClick={() => setWarningPage(currentPage + 1)}>下一页</button>
            </div>
          </> : <div className="sr-review-empty" role="status">本地不再判断剧情语义或生成疑点；请对照全文与 AI 返回，自行决定是否采用。</div>}
        </section>}
      </div>

      <p className="sr-review-copy-status" role="status" aria-live="polite">{copyStatus || '文本只读，可选择或复制；Markdown 等内容只作为文字显示。'}</p>
      <footer className="sr-review-footer">
        <p>采用只放入编辑区，不保存、不解析；可还原处理前文本。</p>
        <div className="sr-review-actions">
          <button type="button" className="btn" onClick={onKeepOriginal}>不采用，保留原文</button>
          <button type="button" className="btn primary" disabled={stale} onClick={() => { if (!stale) onAdopt(); }}
            title={stale ? '原文或项目已变化，不能采用此旧结果' : undefined}>采用到编辑区</button>
        </div>
      </footer>
    </div>
  </div>;

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
