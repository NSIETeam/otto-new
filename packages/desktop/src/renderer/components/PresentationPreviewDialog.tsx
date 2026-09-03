/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LocalArtifactPreviewResult } from '../../preload/index.js';
import { IconChevron, IconClose, IconFolder } from './icons.js';
import { useModalDialog } from './useModalDialog.js';

export function PresentationPreviewDialog({
  open,
  filePath,
  preview,
  loading,
  error,
  onClose,
  onReveal,
  onOpenExternally,
  onRetry,
  canReveal,
  canOpenExternally,
}: {
  open: boolean;
  filePath: string;
  preview: LocalArtifactPreviewResult | null;
  loading: boolean;
  error: string | null;
  onClose(): void;
  onReveal(): void;
  onOpenExternally(): void;
  onRetry(): void;
  canReveal: boolean;
  canOpenExternally: boolean;
}): React.JSX.Element | null {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const modal = useModalDialog(open, onClose);
  useEffect(() => {
    setSelectedIndex(0);
    setZoom(1);
  }, [filePath, open]);

  const slides = preview?.kind === 'slides' ? preview.slides : [];
  const selectedSlide = slides[selectedIndex] ?? null;
  const fileName =
    preview?.fileName ||
    filePath.replace(/\\/gu, '/').split('/').at(-1) ||
    'PPT';
  const unavailable =
    error || (!loading && preview && !preview.ok ? preview.error : null);
  const setSafeZoom = (next: number): void => {
    setZoom(Math.min(2, Math.max(0.5, next)));
  };
  const changePage = (next: number): void => {
    setSelectedIndex(Math.min(slides.length - 1, Math.max(0, next)));
  };
  const onShortcut = (event: React.KeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select')) return;
    if (event.key === 'ArrowRight' || event.key === 'PageDown') {
      event.preventDefault();
      changePage(selectedIndex + 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      changePage(selectedIndex - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      changePage(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      changePage(slides.length - 1);
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      setSafeZoom(zoom + 0.25);
    } else if (event.key === '-') {
      event.preventDefault();
      setSafeZoom(zoom - 0.25);
    } else if (event.key === '0') {
      event.preventDefault();
      setZoom(1);
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      className="otto-presentation-preview-overlay"
      onMouseDown={modal.onBackdropMouseDown}
    >
      <section
        ref={modal.dialogRef}
        className="otto-presentation-preview"
        role="dialog"
        aria-modal="true"
        aria-label={`预览 ${fileName}`}
        onKeyDownCapture={onShortcut}
        onKeyDown={modal.onKeyDown}
      >
        <header className="otto-presentation-preview__header">
          <div>
            <h2>{fileName}</h2>
            <p>
              {slides.length > 0 ? `PPT · ${slides.length} 页` : 'PPT 交付物'}
            </p>
            {preview?.notice ? <p role="note">{preview.notice}</p> : null}
          </div>
          <div className="otto-presentation-preview__header-actions">
            {canReveal ? (
              <button type="button" onClick={onReveal}>
                <IconFolder size={15} />
                在文件夹中显示
              </button>
            ) : null}
            {canOpenExternally ? (
              <button
                type="button"
                className="otto-presentation-preview__external"
                onClick={onOpenExternally}
              >
                用其他应用打开
              </button>
            ) : null}
            <button
              ref={modal.closeRef}
              type="button"
              className="otto-presentation-preview__close"
              aria-label="关闭 PPT 预览"
              onClick={onClose}
            >
              <IconClose size={18} />
            </button>
          </div>
        </header>

        {loading ? (
          <div className="otto-presentation-preview__empty" role="status">
            正在准备逐页预览…
          </div>
        ) : unavailable ? (
          <div className="otto-presentation-preview__empty" role="status">
            <strong>暂时无法在 Otto 内显示这份 PPT</strong>
            <span>{unavailable}</span>
            <button type="button" onClick={onRetry}>
              重新加载预览
            </button>
          </div>
        ) : selectedSlide ? (
          <div className="otto-presentation-preview__workspace">
            <nav
              aria-label="PPT 页面"
              className="otto-presentation-preview__rail"
            >
              {slides.map((slide, index) => (
                <button
                  type="button"
                  key={slide.fileName}
                  className={
                    index === selectedIndex ? 'is-selected' : undefined
                  }
                  aria-label={`查看第 ${slide.number} 页`}
                  aria-current={index === selectedIndex ? 'page' : undefined}
                  onClick={() => setSelectedIndex(index)}
                >
                  <span>{slide.number}</span>
                  <img src={slide.dataUrl} alt="" />
                </button>
              ))}
            </nav>
            <main className="otto-presentation-preview__canvas">
              <div
                className="otto-presentation-preview__viewport"
                style={preview?.notice ? { alignItems: 'start' } : undefined}
              >
                <img
                  src={selectedSlide.dataUrl}
                  alt={`第 ${selectedSlide.number} 页`}
                  style={
                    zoom === 1 && !preview?.notice
                      ? undefined
                      : {
                          width: `${zoom * 100}%`,
                          maxWidth: 'none',
                          maxHeight: 'none',
                        }
                  }
                />
              </div>
              <footer>
                <button
                  type="button"
                  aria-label="上一页"
                  disabled={selectedIndex === 0}
                  onClick={() => changePage(selectedIndex - 1)}
                >
                  <IconChevron size={17} className="is-previous" />
                </button>
                <span>
                  {selectedSlide.number} / {slides.length}
                </span>
                <button
                  type="button"
                  aria-label="下一页"
                  disabled={selectedIndex === slides.length - 1}
                  onClick={() => changePage(selectedIndex + 1)}
                >
                  <IconChevron size={17} />
                </button>
                <span
                  className="otto-presentation-preview__zoom-divider"
                  aria-hidden="true"
                />
                <button
                  type="button"
                  aria-label="缩小 PPT"
                  disabled={zoom <= 0.5}
                  onClick={() => setSafeZoom(zoom - 0.25)}
                >
                  −
                </button>
                <span role="status" aria-label="当前缩放比例">
                  {Math.round(zoom * 100)}%
                </span>
                <button
                  type="button"
                  aria-label="放大 PPT"
                  disabled={zoom >= 2}
                  onClick={() => setSafeZoom(zoom + 0.25)}
                >
                  +
                </button>
                {zoom !== 1 ? (
                  <button
                    type="button"
                    className="otto-presentation-preview__fit"
                    onClick={() => setZoom(1)}
                  >
                    适合窗口
                  </button>
                ) : null}
              </footer>
            </main>
          </div>
        ) : (
          <div className="otto-presentation-preview__empty" role="status">
            暂无可显示的页面。
          </div>
        )}
      </section>
    </div>,
    document.body,
  );
}
