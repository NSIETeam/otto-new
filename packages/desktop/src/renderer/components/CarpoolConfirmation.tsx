/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
/** A nested confirmation owns Escape/Tab without closing its parent workspace. */
export function CarpoolConfirmation({
  label,
  onCancel,
  children,
  role = 'alertdialog',
  className = '',
}: {
  label: string;
  role?: 'dialog' | 'alertdialog';
  className?: string;
  onCancel(): void;
  children: React.ReactNode;
}): React.JSX.Element {
  const ref = useRef<HTMLElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusable = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]',
        ) ?? [],
      );
    focusable()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel.current();
        return;
      }
      if (event.key !== 'Tab') return;
      event.stopImmediatePropagation();
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (!first) {
        event.preventDefault();
        ref.current?.focus();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !ref.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !ref.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('keydown', key, true);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);
  return createPortal(
    <div className="otto-workspace-dialog-overlay" style={{ zIndex: 10000 }}>
      <section
        ref={ref}
        tabIndex={-1}
        className={`otto-workspace-dialog ${className}`}
        role={role}
        aria-modal="true"
        aria-label={label}
      >
        <h2>{label}</h2>
        {children}
      </section>
    </div>,
    document.body,
  );
}
