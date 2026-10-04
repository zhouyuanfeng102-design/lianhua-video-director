import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';

import './ModelPickerModal.css';

export interface ModelPickerModalProps {
  models: readonly string[];
  currentModel: string;
  title: string;
  fontScalePercent: number;
  onSelect: (model: string) => void;
  onClose: () => void;
}

const normalize = (value: string) => value.trim().toLocaleLowerCase('zh-CN');

export function ModelPickerModal({
  models,
  currentModel,
  title,
  fontScalePercent,
  onSelect,
  onClose,
}: ModelPickerModalProps) {
  const titleId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const originalFocusRef = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState('');

  const visibleModels = useMemo(() => {
    const normalizedQuery = normalize(query);
    return normalizedQuery
      ? models.filter((model) => normalize(model).includes(normalizedQuery))
      : models;
  }, [models, query]);

  useLayoutEffect(() => {
    originalFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    searchRef.current?.focus();

    return () => {
      const originalFocus = originalFocusRef.current;
      if (originalFocus?.isConnected) originalFocus.focus();
    };
  }, []);

  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  const focusModel = (index: number) => {
    const option = dialogRef.current?.querySelector<HTMLButtonElement>(
      `.model-picker-option[data-model-index="${index}"]`,
    );
    option?.focus();
    option?.scrollIntoView({ block: 'nearest' });
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && visibleModels.length > 0) {
      event.preventDefault();
      focusModel(0);
    }
  };

  const handleOptionKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') nextIndex = Math.min(index + 1, visibleModels.length - 1);
    if (event.key === 'ArrowUp') nextIndex = Math.max(index - 1, 0);
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = visibleModels.length - 1;

    if (nextIndex !== null) {
      event.preventDefault();
      focusModel(nextIndex);
    }
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) return;

    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    if (event.shiftKey && (currentIndex === 0 || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      focusable[focusable.length - 1]?.focus();
    } else if (!event.shiftKey && currentIndex === focusable.length - 1) {
      event.preventDefault();
      focusable[0]?.focus();
    }
  };

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  const portalStyle = {
    '--ui-font-scale': String(Math.max(fontScalePercent, 1) / 100),
  } as CSSProperties;

  return createPortal(
    <div
      className="model-picker-backdrop"
      style={portalStyle}
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        className="model-picker-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="model-picker-header">
          <h2 id={titleId}>{title}</h2>
          <button className="model-picker-close" type="button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="model-picker-search-wrap">
          <label className="model-picker-search-label" htmlFor={`${titleId}-search`}>搜索模型</label>
          <input
            ref={searchRef}
            id={`${titleId}-search`}
            className="model-picker-search"
            type="search"
            aria-label="搜索模型"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="输入模型名称或 ID"
          />
          <p className="model-picker-count" aria-live="polite">
            共 {models.length} 个模型，匹配 {visibleModels.length} 个
          </p>
        </div>

        <div className="model-picker-list" role="listbox" aria-label={title} tabIndex={-1}>
          {visibleModels.length > 0 ? visibleModels.map((model, index) => (
            <button
              key={model}
              className="model-picker-option"
              data-model-index={index}
              type="button"
              role="option"
              aria-label={model}
              aria-selected={model === currentModel}
              tabIndex={-1}
              onKeyDown={(event) => handleOptionKeyDown(event, index)}
              onClick={() => onSelect(model)}
            >
              {model}
            </button>
          )) : (
            <div className="model-picker-empty" role="status">没有匹配的模型</div>
          )}
        </div>

        <footer className="model-picker-footer">
          <span>选择一个模型即可应用</span>
          <button className="model-picker-cancel" type="button" onClick={onClose}>关闭</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
