import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearLayouts,
  layoutGeneration,
  readLayout,
  saveLayout,
} from './layoutCache.js';
beforeEach(clearLayouts);
describe('authorized session layout cache', () => {
  const snapshot = {
    positions: [
      { id: 'visible', x: 1, y: 2 },
      { id: 'withdrawn', x: 3, y: 4 },
    ],
    camera: { x: 5, y: 6, zoom: 1 },
  };
  it('isolates identities and prunes withdrawn nodes', () => {
    saveLayout('a:park:real', snapshot, layoutGeneration());
    expect(readLayout('b:park:real', new Set(['visible']))).toBeNull();
    expect(readLayout('a:park:real', new Set(['visible']))?.positions).toEqual([
      { id: 'visible', x: 1, y: 2 },
    ]);
  });
  it('prevents an old unmount from repopulating geometry after logout', () => {
    const old = layoutGeneration();
    clearLayouts();
    saveLayout('a', snapshot, old);
    expect(readLayout('a', new Set(['visible']))).toBeNull();
  });
});
