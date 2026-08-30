/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { trayMenuInputVersion } from './tray-menu-state.js';

describe('tray menu input version', () => {
  it('stays stable while the visible menu state is unchanged', () => {
    const input = {
      status: 'Otto 已就绪',
      restarting: false,
      contacts: [{ count: 2 }, { count: 1 }],
    };

    expect(trayMenuInputVersion(input)).toBe(trayMenuInputVersion({
      ...input,
      contacts: input.contacts.map((contact) => ({ ...contact })),
    }));
  });

  it('changes only when a menu-visible value changes', () => {
    const baseline = trayMenuInputVersion({
      status: 'Otto 已就绪',
      restarting: false,
      contacts: [{ count: 2 }],
    });

    expect(trayMenuInputVersion({
      status: '正在重启…',
      restarting: true,
      contacts: [{ count: 2 }],
    })).not.toBe(baseline);
    expect(trayMenuInputVersion({
      status: 'Otto 已就绪',
      restarting: false,
      contacts: [{ count: 3 }],
    })).not.toBe(baseline);
    expect(trayMenuInputVersion({
      status: 'Otto 已就绪',
      restarting: false,
      contacts: [{ count: 1 }, { count: 1 }],
    })).not.toBe(baseline);
  });
});
