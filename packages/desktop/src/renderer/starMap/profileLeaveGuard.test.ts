import { expect, it, vi } from 'vitest';
import { confirmProfileLeave } from './profileLeaveGuard.js';
it('only asks to discard dirty profile fields within the closing surface', () => {
  const root = document.createElement('div');
  const confirm = vi.fn(() => false);
  expect(confirmProfileLeave(root, confirm)).toBe(true);
  root.innerHTML = '<section data-profile-dirty="true"></section>';
  expect(confirmProfileLeave(root, confirm)).toBe(false);
  expect(confirm).toHaveBeenCalledOnce();
  confirm.mockReturnValue(true);
  expect(confirmProfileLeave(root, confirm)).toBe(true);
});
