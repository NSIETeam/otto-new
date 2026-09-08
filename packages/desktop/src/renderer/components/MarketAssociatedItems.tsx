/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useState, useRef } from 'react';
import { startNonOverlappingPoll } from '../lib/nonOverlappingPoll.js';
import { marketRequest } from '../parkMarketApi.js';
export interface AssociatedMarketItem {
  listingId: string;
  messageId: string;
  sequence: number;
  title: string;
  unavailable: boolean;
}
interface Page {
  items: AssociatedMarketItem[];
  nextBeforeSequence: number | null;
}
export function MarketAssociatedItems({
  conversationId,
  revision,
  onLocate,
}: {
  conversationId: string;
  revision: number;
  onLocate(item: AssociatedMarketItem): Promise<void>;
}) {
  const [page, setPage] = useState<Page>({
    items: [],
    nextBeforeSequence: null,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const current = useRef(conversationId);
  current.current = conversationId;
  const loadedCount = useRef(0);
  loadedCount.current = page.items.length;
  const mutation = useRef(0);
  useEffect(() => {
    let alive = true;
    const stop = startNonOverlappingPoll(async () => {
      const started = mutation.current;
      try {
        const next = await marketRequest<Page>(
          `/conversations/${conversationId}/items`,
        );
        const cursors = new Set<number>();
        while (
          next.nextBeforeSequence !== null &&
          next.items.length < loadedCount.current
        ) {
          if (cursors.has(next.nextBeforeSequence)) break;
          cursors.add(next.nextBeforeSequence);
          const older = await marketRequest<Page>(
            `/conversations/${conversationId}/items?beforeSequence=${next.nextBeforeSequence}`,
          );
          if (!alive || started !== mutation.current) return;
          next.items = [
            ...new Map(
              [...next.items, ...older.items].map((item) => [
                item.listingId,
                item,
              ]),
            ).values(),
          ];
          next.nextBeforeSequence = older.nextBeforeSequence;
        }
        if (alive && started === mutation.current) {
          setPage(next);
          setError('');
        }
      } catch (error) {
        if (alive) setError(String(error));
      }
    }, 8000);
    return () => {
      alive = false;
      stop();
    };
  }, [conversationId, revision]);
  return (
    <nav aria-label="会话关联商品">
      {error && <p role="alert">{error}</p>}
      {page.items.map((item) => (
        <button
          key={item.listingId}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onLocate(item)
              .catch((e) => setError(String(e)))
              .finally(() => setBusy(false));
          }}
        >
          {item.title}
        </button>
      ))}
      {page.nextBeforeSequence !== null && (
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void marketRequest<Page>(
              `/conversations/${conversationId}/items?beforeSequence=${page.nextBeforeSequence}`,
            )
              .then((next) => {
                if (current.current === conversationId) {
                  mutation.current++;
                  setPage((previous) => ({
                    items: [
                      ...new Map(
                        [...previous.items, ...next.items].map((item) => [
                          item.listingId,
                          item,
                        ]),
                      ).values(),
                    ],
                    nextBeforeSequence: next.nextBeforeSequence,
                  }));
                }
              })
              .catch((e) => setError(String(e)))
              .finally(() => setBusy(false));
          }}
        >
          更多关联商品
        </button>
      )}
    </nav>
  );
}
