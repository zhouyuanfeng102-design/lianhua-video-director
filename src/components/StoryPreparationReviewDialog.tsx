import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { getStoryPreparationParagraphs, type StoryPreparationResult } from '../storyPreparationReview';
import type { StoryReferenceContext } from '../types';
import { StoryReferenceAnalysisView } from './StoryReferencePanel';
import '../storyPreparationReview.css';

export interface StoryPreparationReviewDialogProps {
  original: string;
  result: StoryPreparationResult;
  stale: boolean;
  /** Reuse the comparison to inspect an already adopted source snapshot. */
  sourceOnly?: boolean;
  fontScalePercent?: number;
  referenceContext?: StoryReferenceContext;
  onRegenerate?: () => void;
  onRewriteParagraph?: (paragraphId: string) => void;
  busy?: boolean;
  progress?: string;
  detailMode?: 'faithful' | 'detailed';
  onDetailModeChange?: (mode: 'faithful' | 'detailed') => void;
  onAdopt: () => void;
  onKeepOriginal: () => void;
  /** Hide the dialog without discarding the pending result. */
  onClose: () => void;
}

type ReviewTab = 'comparison' | 'actions';

/** Metadata is displayed as prose, never executed as markup or instructions. */
function detailText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(detailText).filter(Boolean).join('；');
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    return [item.label, item.description ?? item.text ?? item.action ?? item.phase]
      .filter((part): part is string => typeof part === 'string' && Boolean(part)).join('：');
  }
  return '';
}

/** The returned story is always plain, read-only text until the caller accepts it. */
export function StoryPreparationReviewDialog({
  original, result, stale, sourceOnly = false, fontScalePercent = 100, referenceContext,
  onRegenerate, onRewriteParagraph, busy = false, progress, detailMode, onDetailModeChange,
  onAdopt, onKeepOriginal, onClose,
}: StoryPreparationReviewDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const comparisonId = useId();
  const actionsId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const originalRef = useRef<HTMLTextAreaElement>(null);
  const resultRef = useRef<HTMLTextAreaElement>(null);
  const callbacksRef = useRef({ onClose });
  const mountedRef = useRef(true);
  callbacksRef.current = { onClose };
  const paragraphs = getStoryPreparationParagraphs(result);
  const sceneCount = result.actionPlan?.scenes?.length ?? 0;
  const reviewItemUnit = sceneCount ? '场' : '段';
  const reviewItemCount = sceneCount || paragraphs.length;
  const hasParagraphs = paragraphs.length > 0;
  const [tab, setTab] = useState<ReviewTab>(hasParagraphs && !sourceOnly ? 'actions' : 'comparison');
  const [selectedParagraphId, setSelectedParagraphId] = useState(paragraphs[0]?.id ?? '');
  const [copyStatus, setCopyStatus] = useState('');
  const sourceParagraphMap = new Map((result.actionPlan?.sourceParagraphs ?? []).map((paragraph) => [paragraph.id, paragraph.text]));
  const paragraphSources = (paragraph: typeof paragraphs[number]) => paragraph.sourceParagraphIds
    .map((id) => sourceParagraphMap.get(id) ?? '').filter(Boolean).join('\n\n');
  const selectedParagraph = paragraphs.find((paragraph) => paragraph.id === selectedParagraphId) ?? paragraphs[0];
  const selectedEvents = selectedParagraph ? (result.actionPlan?.events ?? [])
    .filter((event) => selectedParagraph.eventIds.includes(event.id)) : [];
  const availableTabs: ReviewTab[] = ['comparison', ...(hasParagraphs ? ['actions' as const] : [])];
  const activeTab = availableTabs.includes(tab) ? tab : 'comparison';
  const actionDisabled = stale || busy || sourceOnly;
  const currentDetailMode = detailMode ?? result.detailMode ?? 'detailed';

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
    setTab(hasParagraphs && !sourceOnly ? 'actions' : 'comparison');
    setSelectedParagraphId(paragraphs[0]?.id ?? '');
    setCopyStatus('');
    // Rewriting a paragraph must retain the active paragraph and review tab.
    // A replacement original starts a new review, while result updates stay in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original]);

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
    const index = availableTabs.indexOf(activeTab);
    const nextTab = event.key === 'Home' ? availableTabs[0] : event.key === 'End' ? availableTabs[availableTabs.length - 1]
      : availableTabs[(index + (event.key === 'ArrowLeft' ? -1 : 1) + availableTabs.length) % availableTabs.length];
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
          <h2 id={titleId}>{sourceOnly ? '画面描述 · 转化来源' : 'AI 画面描述转化 · 结果审阅'}</h2>
          <p id={descriptionId}>{sourceOnly
            ? `当前${sceneCount ? '场景稿' : '画面描述'}对应的处理前原文与已采用结果，可查看和复制。`
            : `查看 AI 返回的${sceneCount ? '场景稿' : '画面描述'}、动作理解与编排补充。采用后放入编辑区，当前原文尚未改动。`}</p>
        </div>
        <button type="button" className="btn sr-review-later" onClick={onClose}>{sourceOnly ? '关闭' : '稍后查看'}</button>
      </header>

      <div className="sr-review-tabs" role="tablist" aria-label="画面描述转化审阅视图">
        <button type="button" className="btn" role="tab" id={`${comparisonId}-tab`}
          data-review-tab="comparison" aria-selected={activeTab === 'comparison'} aria-controls={comparisonId}
          tabIndex={activeTab === 'comparison' ? 0 : -1} onClick={() => setTab('comparison')} onKeyDown={onTabKeyDown}>全文对照</button>
        {hasParagraphs && <button type="button" className="btn" role="tab" id={`${actionsId}-tab`}
          data-review-tab="actions" aria-selected={activeTab === 'actions'} aria-controls={actionsId}
          tabIndex={activeTab === 'actions' ? 0 : -1} onClick={() => setTab('actions')} onKeyDown={onTabKeyDown}>{sceneCount ? '场景' : '分段'}与 AI 依据（{reviewItemCount}）</button>}
      </div>

      {!sourceOnly && (onRegenerate || onDetailModeChange || busy) && <div className="sr-review-conversion-tools">
        {onDetailModeChange && <label className="sr-review-detail-mode">转化细节
          <select aria-label="转化细节" value={currentDetailMode} disabled={busy}
            onChange={(event) => onDetailModeChange(event.target.value === 'faithful' ? 'faithful' : 'detailed')}>
            <option value="faithful">忠实细化</option><option value="detailed">细致动作与打斗</option>
          </select>
        </label>}
        <span className="sr-review-tool-note">{currentDetailMode === 'faithful' ? '细化原文已有动作，保留未确定信息。' : '细化普通动作与打斗过程，原文事实不变；必要编排列入补充说明。'}</span>
        {onRegenerate && <button type="button" className="btn small" data-review-regenerate disabled={busy}
          onClick={() => { if (!busy) onRegenerate(); }}>重新转化</button>}
      </div>}

      {busy && <p className="sr-review-progress" role="status" aria-live="polite">{progress || '正在转化，请稍候…'}</p>}

      {stale && <p className="sr-review-stale" role="status">原文、参考资料、设置或当前项目已变化，此结果对应旧输入，不能覆盖当前编辑区。可重新转化，或查看、复制旧结果。</p>}

      {referenceContext && <details className="sr-review-reference-source">
        <summary>本次使用的参考资料：{referenceContext.references.map((reference) => `图${reference.number}`).join('、')}</summary>
        <div className="sr-review-reference-content">
          {referenceContext.narrator && <p>“我”：{referenceContext.narrator.name || '已有项目人物'} {referenceContext.narrator.description}</p>}
          {referenceContext.references.map((reference) => <article key={reference.referenceId}>
            <strong>图{reference.number} · 识别版本 {reference.analysis.revision}</strong>
            <StoryReferenceAnalysisView analysis={reference.analysis} />
            {reference.fullDescription !== undefined && <p className="story-reference-prose">人工修订：{reference.fullDescription}</p>}
            {reference.notes && <p className="story-reference-prose">补充要求：{reference.notes}</p>}
            {reference.subjectBindings.length > 0 && <p>主体对应：{reference.subjectBindings.map((binding) => {
              const subjects = binding.kind === 'character' ? reference.analysis.characters : binding.kind === 'location' ? reference.analysis.locations : reference.analysis.props;
              const subject = subjects.find((item) => item.id === binding.subjectId);
              return `${subject?.label || binding.subjectId}${binding.name ? `＝${binding.name}` : ''}${binding.isNarrator ? '（我）' : ''}`;
            }).join('；')}</p>}
          </article>)}
        </div>
      </details>}

      <div className="sr-review-content">
        {activeTab === 'comparison' ? <section className="sr-review-comparison" id={comparisonId} role="tabpanel" aria-labelledby={`${comparisonId}-tab`}>
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
        </section> : <section className="sr-review-paragraphs" id={actionsId} role="tabpanel" aria-labelledby={`${actionsId}-tab`}>
          <div className="sr-review-paragraph-toolbar">
            <span>共 {reviewItemCount} {reviewItemUnit} · 依据与编排说明由 AI 返回</span>
          </div>
          <div className="sr-review-paragraph-layout">
            <nav className="sr-review-paragraph-nav" aria-label={sceneCount ? '转化场景' : '转化段落'}>
              {paragraphs.map((paragraph) => <button type="button" key={paragraph.id}
                className="sr-review-paragraph-link" data-review-paragraph={paragraph.id}
                aria-current={selectedParagraph?.id === paragraph.id ? 'true' : undefined}
                onClick={() => setSelectedParagraphId(paragraph.id)}>
                <span className="sr-review-paragraph-index">第 {paragraphs.indexOf(paragraph) + 1} {reviewItemUnit}</span>
                <span className="sr-review-paragraph-excerpt">{paragraph.text}</span>
              </button>)}
            </nav>
            {selectedParagraph ? <article className="sr-review-paragraph-detail" data-review-selected-paragraph={selectedParagraph.id}>
              <div className="sr-review-paragraph-heading">
                <strong>第 {paragraphs.indexOf(selectedParagraph) + 1} {reviewItemUnit}</strong>
                {!sourceOnly && onRewriteParagraph && <button type="button" className="btn small" data-review-rewrite={selectedParagraph.id}
                  disabled={actionDisabled} onClick={() => { if (!actionDisabled) onRewriteParagraph(selectedParagraph.id); }}>只重做这一{reviewItemUnit}</button>}
              </div>
              <div className="sr-review-paragraph-comparison">
                <section className="sr-review-prose-column"><h3>AI 返回的原文依据</h3>
                  <div className="sr-review-prose" tabIndex={0} aria-label={`本${reviewItemUnit}原文依据`}>{paragraphSources(selectedParagraph) || `模型未提供本${reviewItemUnit}依据。`}</div>
                </section>
                <section className="sr-review-prose-column"><h3>转化后的{sceneCount ? '场景稿' : '画面描述'}</h3>
                  <div className="sr-review-prose" tabIndex={0} aria-label={sceneCount ? '本场场景稿' : '本段画面描述'}>{selectedParagraph.text}</div>
                </section>
              </div>
              {selectedEvents.length > 0 && <details className="sr-review-event-facts" open>
                <summary>AI 剧情理解与动作说明（{selectedEvents.length}）</summary>
                {selectedEvents.map((event, index) => <div className="sr-review-event" key={index}>
                  <strong>{[event.actor, event.action, event.target].filter(Boolean).join(' · ')}</strong>
                  {detailText(event.evidence) && <p><span>模型引用：</span>{detailText(event.evidence)}</p>}
                  {detailText(event.phases) && <p><span>动作过程：</span>{detailText(event.phases)}</p>}
                  {detailText(event.result) && <p><span>结果：</span>{detailText(event.result)}</p>}
                  {detailText(event.uncertainties) && <p className="sr-review-event-uncertainty"><span>未确定：</span>{detailText(event.uncertainties)}</p>}
                </div>)}
              </details>}
              <section className={`sr-review-staging${selectedParagraph.stagingAdditions.length ? ' has-additions' : ''}`} aria-label={`本${reviewItemUnit}编排补充`}>
                <h3>编排补充 <span>（由 AI 声明）</span></h3>
                {selectedParagraph.stagingAdditions.length ? <ul>{selectedParagraph.stagingAdditions.map((addition, index) => <li key={index}>{addition}</li>)}</ul>
                  : <p>本{reviewItemUnit}未声明编排补充。</p>}
              </section>
            </article> : <div className="sr-review-empty" role="status">暂无可显示的{sceneCount ? '场景' : '段落'}。</div>}
          </div>
        </section>}
      </div>

      <p className="sr-review-copy-status" role="status" aria-live="polite">{copyStatus || '文本只读，可选择或复制；Markdown 等内容只作为文字显示。'}</p>
      <footer className="sr-review-footer">
        <p>{sourceOnly ? '来源快照只供回查，不会覆盖当前文本。' : '采用后放入编辑区并保留转化来源；可还原处理前文本，确认后再保存或解析。'}</p>
        {!sourceOnly && <div className="sr-review-actions">
          <button type="button" className="btn" onClick={onKeepOriginal}>不采用，保留原文</button>
          <button type="button" className="btn primary" disabled={actionDisabled} onClick={() => { if (!actionDisabled) onAdopt(); }}
            title={stale ? '原文或项目已变化，不能采用此旧结果' : undefined}>采用到编辑区</button>
        </div>}
      </footer>
    </div>
  </div>;

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
