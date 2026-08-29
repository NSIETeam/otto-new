/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import type { RpaDriver } from './ports.js';
import { CompositeRpaDriver } from './composite-driver.js';

const run = { id: 'rpa-test' } as never;

function driver(label: string): RpaDriver {
  return { execute: vi.fn(async () => ({ output: { driver: label } })) };
}

describe('CompositeRpaDriver', () => {
  it('routes only fixed web and desktop namespaces', async () => {
    const web = driver('web');
    const desktop = driver('desktop');
    const composite = new CompositeRpaDriver(web, desktop);

    await expect(composite.execute({ run, step: { id: 'web', action: 'web.wait', args: {}, sideEffect: 'none' }, idempotencyKey: 'one' })).resolves.toMatchObject({ output: { driver: 'web' } });
    await expect(composite.execute({ run, step: { id: 'desktop', action: 'desktop.inspect', args: {}, sideEffect: 'none' }, idempotencyKey: 'two' })).resolves.toMatchObject({ output: { driver: 'desktop' } });
  });

  it('fails closed when no privileged desktop host is registered', async () => {
    const composite = new CompositeRpaDriver(driver('web'));
    expect(() => composite.execute({ run, step: { id: 'desktop', action: 'desktop.click', args: {}, sideEffect: 'external' }, idempotencyKey: 'three' }))
      .toThrow('signed accessibility host is not registered');
  });
});
