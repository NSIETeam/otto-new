import { expect, it, vi } from 'vitest';
import { ParkCarpoolStartup } from './park-carpool-startup.js';
const scope = {
  serverUrl: 'http://localhost',
  organizationId: 'org',
  accountId: 'a',
  deviceId: 'device',
  approvalState: 'approved',
};
it('does not block private startup and never starts a stale identity', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chat = {
    close: vi.fn(async () => {}),
    activate: vi.fn(() => pending),
    start: vi.fn(),
  };
  const startup = new ParkCarpoolStartup(
    () => chat,
    async () => true,
    vi.fn(),
  );
  startup.update(scope);
  await vi.waitFor(() => expect(chat.activate).toHaveBeenCalledOnce());
  const privateStarted = vi.fn();
  privateStarted();
  expect(privateStarted).toHaveBeenCalledOnce();
  startup.update(null);
  release();
  await startup.settled();
  expect(chat.start).not.toHaveBeenCalled();
});
it('checks permission before activation and isolates failure from later identities', async () => {
  const chat = {
    close: vi.fn(async () => {}),
    activate: vi.fn(async () => {}),
    start: vi.fn(),
  };
  const eligible = vi.fn(async () => false);
  const error = vi.fn();
  const startup = new ParkCarpoolStartup(() => chat, eligible, error);
  startup.update(scope);
  await startup.settled();
  expect(chat.activate).not.toHaveBeenCalled();
  eligible.mockRejectedValueOnce(new Error('offline'));
  startup.update(scope);
  await startup.settled();
  expect(error).toHaveBeenCalledOnce();
  eligible.mockResolvedValue(true);
  startup.update({ ...scope, accountId: 'b' });
  await startup.settled();
  expect(chat.start).toHaveBeenCalledOnce();
});
it('times out optional initialization and does not start it after a late completion', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chat = {
    close: vi.fn(async () => {}),
    activate: vi.fn(() => pending),
    start: vi.fn(),
  };
  const error = vi.fn();
  const startup = new ParkCarpoolStartup(
    () => chat,
    async () => true,
    error,
    100,
  );
  try {
    startup.update(scope);
    await vi.advanceTimersByTimeAsync(0);
    expect(chat.activate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(101);
    expect(error).toHaveBeenCalledOnce();
    release();
    await startup.settled();
    expect(chat.start).not.toHaveBeenCalled();
  } finally {
    release();
    await startup.settled();
    vi.useRealTimers();
  }
});
it('releases a timed out permission check so a new login can start', async () => {
  vi.useFakeTimers();
  const chat = {
    close: vi.fn(async () => {}),
    activate: vi.fn(async () => {}),
    start: vi.fn(),
  };
  const eligible = vi
    .fn()
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValue(true);
  const startup = new ParkCarpoolStartup(() => chat, eligible, vi.fn(), 10);
  try {
    startup.update(scope);
    await vi.advanceTimersByTimeAsync(20);
    startup.update({ ...scope, accountId: 'b' });
    await vi.advanceTimersByTimeAsync(0);
    expect(eligible).toHaveBeenCalledTimes(2);
    expect(chat.start).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
it('isolates hung activation and cleanup from another identity and late completion', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const first = {
    close: vi.fn(() => new Promise<void>(() => {})),
    activate: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    ),
    start: vi.fn(),
  };
  const second = {
    close: vi.fn(async () => {}),
    activate: vi.fn(async () => {}),
    start: vi.fn(),
  };
  const factory = vi.fn().mockReturnValueOnce(first).mockReturnValue(second);
  const startup = new ParkCarpoolStartup(
    factory,
    async () => true,
    vi.fn(),
    10,
  );
  try {
    startup.update(scope);
    await vi.advanceTimersByTimeAsync(20);
    await startup.settled();
    startup.update({ ...scope, accountId: 'b' });
    await vi.advanceTimersByTimeAsync(0);
    await startup.settled();
    expect(second.start).toHaveBeenCalledOnce();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.start).not.toHaveBeenCalled();
    expect(second.close).not.toHaveBeenCalled();
  } finally {
    release?.();
    vi.useRealTimers();
  }
});
