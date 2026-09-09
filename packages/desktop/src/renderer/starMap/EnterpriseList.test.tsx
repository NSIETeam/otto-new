import { useState } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EnterpriseList } from './EnterpriseList.js';
import { demoMap } from './model.js';
beforeEach(() =>
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  ),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('windows 1000 enterprises and lets the keyboard reach the last result', async () => {
  const nodes = Array.from({ length: 1000 }, (_, i) => ({
    ...demoMap.nodes[0],
    organizationId: `org-${i}`,
    organizationName: `企业 ${i}`,
  }));
  const select = vi.fn();
  function Example() {
    const [activeIndex, onActiveIndex] = useState(-1);
    return (
      <EnterpriseList
        nodes={[...nodes]}
        id="results"
        selected={null}
        activeIndex={activeIndex}
        onActiveIndex={onActiveIndex}
        onSelect={select}
        ownId=""
      />
    );
  }
  render(<Example />);
  expect(screen.getAllByRole('option').length).toBeLessThan(20);
  fireEvent.keyDown(screen.getAllByRole('option')[0], { key: 'End' });
  const last = await screen.findByRole('option', { name: /企业 999/ });
  await waitFor(() => expect(document.activeElement).toBe(last));
  expect(last.getAttribute('aria-setsize')).toBe('1000');
  expect(screen.getAllByRole('option').length).toBeLessThan(20);
  fireEvent.keyDown(last, { key: 'Enter' });
  expect(select).toHaveBeenCalledWith('org-999');
  fireEvent.keyDown(last, { key: 'Home' });
  await waitFor(() =>
    expect(document.activeElement?.textContent).toContain('企业 0'),
  );
});
