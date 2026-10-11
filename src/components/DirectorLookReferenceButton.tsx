import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ImageOff, ImagePlus, LoaderCircle, Trash2, Upload, X } from 'lucide-react';
import type { ReferenceAsset } from '../types';
import './DirectorLookReferenceButton.css';

export interface DirectorLookReferenceButtonProps {
  asset?: ReferenceAsset;
  /** Resolved by the owner so managed assets use the same safe read path as analysis. */
  previewUrl?: string;
  busy?: boolean;
  uploading?: boolean;
  onUpload: (file: File) => void | Promise<void>;
  onRemove: () => void;
}

function ReferencePreviewDialog({ asset, previewUrl, previewFailed, fontScale, uploading, disabled, onPreviewError, onReplace, onRemove, onClose }: {
  asset: ReferenceAsset;
  previewUrl?: string;
  previewFailed: boolean;
  fontScale: string;
  uploading: boolean;
  disabled: boolean;
  onPreviewError: () => void;
  onReplace: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const dialog = dialogRef.current;
    dialog?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')]
        .filter((element) => element.getClientRects().length > 0);
      if (dialogs[dialogs.length - 1] !== dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = [...(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') || [])]
        .filter((element) => element.getClientRects().length > 0);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) { event.preventDefault(); dialog?.focus(); }
      else if (!dialog?.contains(document.activeElement) || document.activeElement === dialog) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="modal-backdrop director-look-reference-backdrop"
      style={{ '--ui-font-scale': fontScale } as CSSProperties}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={dialogRef} className="modal director-look-reference-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal-head director-look-reference-modal-head">
          <h3 id={titleId}>风格参考图</h3>
          <button type="button" className="btn small ghost" aria-label="关闭风格参考图窗口" onClick={onClose}><X size={16} />关闭</button>
        </div>
        <div className="director-look-reference-preview">
          {previewUrl && !previewFailed
            ? <img src={previewUrl} alt={asset.name || '风格参考图'} onError={onPreviewError} />
            : <div className="director-look-reference-preview-empty"><ImageOff size={28} /><span>参考图暂时无法预览，可重新选择图片。</span></div>}
        </div>
        <div className="director-look-reference-details">
          <span className="director-look-reference-file-name">{asset.fileName || asset.name || '风格参考图'}</span>
          <p>点击「AI 分析填写」识别图片风格；自定义要求可说明希望保留或调整的特点。</p>
        </div>
        <div className="director-look-reference-modal-actions">
          <span role="status">{uploading ? '正在上传参考图…' : '支持 PNG、JPEG、WebP，单张参考图。'}</span>
          <div>
            <button type="button" className="btn small" disabled={disabled} onClick={onReplace}><Upload size={14} />替换参考图</button>
            <button type="button" className="btn small danger" disabled={disabled} onClick={onRemove}><Trash2 size={14} />移除</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function DirectorLookReferenceButton({ asset, previewUrl, busy = false, uploading = false, onUpload, onRemove }: DirectorLookReferenceButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const uploadLockRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [fontScale, setFontScale] = useState('1');
  const [localUploading, setLocalUploading] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const isUploading = uploading || localUploading;
  const disabled = busy || isUploading;

  useEffect(() => { setOpen(false); }, [asset?.id]);
  useEffect(() => { setPreviewFailed(false); }, [asset?.id, previewUrl]);

  const selectFile = () => {
    if (disabled) return;
    if (inputRef.current) {
      inputRef.current.value = '';
      inputRef.current.click();
    }
  };
  const openReference = () => {
    if (!asset) { selectFile(); return; }
    if (triggerRef.current) {
      setFontScale(getComputedStyle(triggerRef.current).getPropertyValue('--ui-font-scale').trim() || '1');
    }
    setOpen(true);
  };

  return <>
    <button
      ref={triggerRef}
      type="button"
      className={`btn small ghost director-look-reference-button${asset ? ' has-reference' : ''}`}
      disabled={!asset && disabled}
      aria-label={asset ? '查看风格参考图' : '上传风格参考图'}
      aria-haspopup={asset ? 'dialog' : undefined}
      aria-expanded={asset ? open : undefined}
      aria-busy={isUploading}
      title={asset ? '查看、替换或移除风格参考图' : '上传单张参考图，再点击 AI 分析填写识别图片风格'}
      onClick={openReference}
    >
      {isUploading ? <LoaderCircle className="director-look-reference-spinner" size={12} aria-hidden="true" />
        : asset && previewUrl && !previewFailed ? <img className="director-look-reference-thumbnail" src={previewUrl} alt="" onError={() => setPreviewFailed(true)} />
          : asset ? <ImageOff size={12} aria-hidden="true" /> : <ImagePlus size={12} aria-hidden="true" />}
      <span className="director-look-reference-label-full">{isUploading ? '上传中…' : asset ? '参考图' : '上传参考图'}</span>
      <span className="director-look-reference-label-short">{isUploading ? '上传中' : '参考图'}</span>
    </button>
    <input
      ref={inputRef}
      className="director-look-reference-file-input"
      type="file"
      accept="image/png,image/jpeg,image/webp"
      multiple={false}
      aria-label="选择风格参考图文件"
      disabled={disabled}
      onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (!file || disabled || uploadLockRef.current) return;
        uploadLockRef.current = true;
        setLocalUploading(true);
        void (async () => {
          try { await onUpload(file); }
          catch { /* The owner reports upload errors and retains the previous reference. */ }
          finally { uploadLockRef.current = false; setLocalUploading(false); }
        })();
      }}
    />
    {open && asset && <ReferencePreviewDialog
      asset={asset}
      previewUrl={previewUrl}
      previewFailed={previewFailed}
      fontScale={fontScale}
      uploading={isUploading}
      disabled={disabled}
      onPreviewError={() => setPreviewFailed(true)}
      onReplace={selectFile}
      onRemove={() => { onRemove(); setOpen(false); }}
      onClose={() => setOpen(false)}
    />}
  </>;
}
