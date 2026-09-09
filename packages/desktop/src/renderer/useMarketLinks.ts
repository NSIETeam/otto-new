/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useState } from 'react';
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
      if (pending) return;
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
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [enabled]);
  return { intent, clear: () => setIntent(null) };
}
