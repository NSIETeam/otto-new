/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { expect, it } from 'vitest';
import { CarpoolConfirmation } from './CarpoolConfirmation.js';
it('traps confirmation focus and restores the opener on Escape', () => {
  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>打开确认</button>
        {open ? (
          <CarpoolConfirmation label="确认停止" onCancel={() => setOpen(false)}>
            <button>确认</button>
            <button onClick={() => setOpen(false)}>取消</button>
          </CarpoolConfirmation>
        ) : null}
      </>
    );
  }
  render(<Host />);
  const opener = screen.getByRole('button', { name: '打开确认' });
  opener.focus();
  fireEvent.click(opener);
  const first = screen.getByRole('button', { name: '确认' });
  const last = screen.getByRole('button', { name: '取消' });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: 'Escape' });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(document.activeElement).toBe(opener);
});
