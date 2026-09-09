/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RecurringTaskRegistry } from 'otto-core/recurring-tasks';
import { useMarketLinks } from './useMarketLinks.js';
import { CarpoolChat } from './components/CarpoolChat.js';
import type { ParkChatView } from '../main/park-carpool-chat.js';

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function chat(id: string): ParkChatView {
  return {
    conversationId: id, status: 'active', generation: 1, canSend: true,
    unavailableHistoryCount: 0, failedMessageCount: 0,
    messages: [{ id, text: `message-${id}`, senderAccountId: id,
      own: false, createdAt: '2026-09-09T00:00:00Z', sequence: 1, pending: false }],
  };
}

it('registers only enabled market polling, serializes slow reads and cancels retained callbacks', async () => {
  vi.useFakeTimers();
  const register = vi.spyOn(RecurringTaskRegistry.prototype, 'register');
  const pending = deferred<{ listingId: string } | null>();
  const poll = vi.fn(() => pending.promise);
  window.otto.enterpriseMarketLink = poll;
  const hook = renderHook(({ enabled }) => useMarketLinks(enabled), { initialProps: { enabled: false } });
  expect(poll).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
  hook.rerender({ enabled: true });
  expect(register).toHaveBeenCalledWith(expect.objectContaining({ intervalMs: 3000, estimatedCostUsdPerRun: 0 }));
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
  expect(poll).toHaveBeenCalledTimes(1);
  hook.rerender({ enabled: false });
  await act(async () => { pending.resolve({ listingId: 'old' }); });
  expect(hook.result.current.intent).toBeNull();
  const registration = register.mock.calls[0][0];
  await act(async () => { await registration.run(); await vi.advanceTimersByTimeAsync(9000); });
  expect(poll).toHaveBeenCalledTimes(1);
  expect((register.mock.contexts[0] as RecurringTaskRegistry).list()).toEqual([]);
});

it('does not let an old conversation response replace the newly selected conversation', async () => {
  vi.useFakeTimers();
  const register = vi.spyOn(RecurringTaskRegistry.prototype, 'register');
  const old = deferred<ParkChatView>();
  const current = deferred<ParkChatView>();
  const read = vi.fn((id: string) => id === 'old' ? old.promise : current.promise);
  window.otto.enterpriseParkCarpoolChatRead = read;
  const view = render(<CarpoolChat conversationId="old" onClose={() => undefined} />);
  view.rerender(<CarpoolChat conversationId="current" onClose={() => undefined} />);
  await act(async () => { current.resolve(chat('current')); });
  expect(screen.getByText('message-current')).toBeTruthy();
  await act(async () => { old.resolve(chat('old')); });
  expect(screen.queryByText('message-old')).toBeNull();
  expect(screen.getByText('message-current')).toBeTruthy();
  expect(register.mock.calls).toHaveLength(2);
  expect((register.mock.contexts[0] as RecurringTaskRegistry).list()).toEqual([]);
  view.unmount();
  await act(async () => {
    for (const [definition] of register.mock.calls) await definition.run();
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect((register.mock.contexts[1] as RecurringTaskRegistry).list()).toEqual([]);
});

it('keeps a dispatched old-conversation send receipt out of the new conversation', async () => {
  vi.useFakeTimers();
  window.otto.enterpriseParkCarpoolChatRead = vi.fn(async (id: string) => chat(id));
  const pending = deferred<ParkChatView>();
  window.otto.enterpriseParkCarpoolChatSend = vi.fn(() => pending.promise);
  const view = render(<CarpoolChat conversationId="old" onClose={() => undefined} />);
  await act(async () => {});
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'one authorized send' } });
  fireEvent.submit(screen.getByRole('textbox').closest('form')!);
  view.rerender(<CarpoolChat conversationId="current" onClose={() => undefined} />);
  await act(async () => {});
  expect(screen.getByText('message-current')).toBeTruthy();
  await act(async () => { pending.resolve(chat('old')); });
  expect(screen.queryByText('message-old')).toBeNull();
  expect(screen.getByText('message-current')).toBeTruthy();
  expect(window.otto.enterpriseParkCarpoolChatSend).toHaveBeenCalledTimes(1);
});
