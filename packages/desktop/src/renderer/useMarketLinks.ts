/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useState } from 'react';
import { RecurringTaskRegistry } from 'otto-core/recurring-tasks';
export function useMarketLinks(enabled: boolean) {
  const [intent, setIntent] = useState<{
    listingId?: string;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!enabled || !window.otto.enterpriseMarketLink) return;
    let active = true;
    let pending = false;
    const poll = async () => {
      if (!active || pending) return;
      pending = true;
      try {
        const result = await window.otto.enterpriseMarketLink!();
        if (active && result) setIntent(result);
      } catch {
        /* Authentication boundaries own login feedback. */
      } finally {
        pending = false;
      }
    };
    void poll();
    const stop = new RecurringTaskRegistry().register({
      name: 'desktop.market-links',
      source: 'packages/desktop/src/renderer/useMarketLinks.ts',
      intervalMs: 3000,
      estimatedCostUsdPerRun: 0,
      getInputVersion: () => String(Date.now()),
      run: poll,
    });
    return () => {
      active = false;
      stop?.();
    };
  }, [enabled]);
  return { intent, clear: () => setIntent(null) };
}
