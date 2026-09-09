/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { MlsDeviceScope } from '@otto/native';
type Scope = MlsDeviceScope & { approvalState: string };
interface Chat {
  close(): Promise<void>;
  activate(scope: Scope, signal?: AbortSignal): Promise<void>;
  start(): void;
}
/** Independent, cancelable attempts; late IO can only close its own chat instance. */
export class ParkCarpoolStartup {
  private controller: AbortController | undefined;
  private current: { chat: Chat; key: string } | undefined;
  private pending: Promise<void> = Promise.resolve();
  private draining = new Map<string, Promise<void>>();
  constructor(
    private readonly createChat: () => Chat,
    private readonly eligible: () => Promise<boolean>,
    private readonly onError: (error: unknown) => void,
    private readonly timeoutMs = 10_000,
  ) {}
  private close(chat: Chat, key: string): void {
    const closing = chat.close();
    const previous = this.draining.get(key);
    const drain = Promise.all([previous, closing]).then(() => undefined);
    this.draining.set(key, drain);
    void drain.then(
      () => {
        if (this.draining.get(key) === drain) this.draining.delete(key);
      },
      () => undefined,
    );
  }
  update(scope: Scope | null): void {
    this.controller?.abort();
    if (this.current) {
      this.close(this.current.chat, this.current.key);
      this.current = undefined;
    }
    if (!scope || scope.approvalState !== 'approved') {
      this.controller = undefined;
      this.pending = Promise.resolve();
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    const key = JSON.stringify(scope);
    const signal = controller.signal;
    let chat: Chat | undefined;
    const cancelled = new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      }),
    );
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error('拼车初始化超时，原企业消息不受影响，请稍后重新登录重试'),
        ),
      this.timeoutMs,
    );
    const work = (async () => {
      // A retry of the same device must not race writes to the same encrypted manifest.
      await this.draining.get(key);
      signal.throwIfAborted();
      if (!(await this.eligible())) return;
      signal.throwIfAborted();
      chat = this.createChat();
      this.current = { chat, key };
      await chat.activate(scope, signal);
      signal.throwIfAborted();
      chat.start();
    })();
    this.pending = Promise.race([work, cancelled])
      .catch((error) => {
        if (chat) {
          this.close(chat, key);
          if (this.current?.chat === chat) this.current = undefined;
        }
        if (this.controller === controller) this.onError(error);
      })
      .finally(() => clearTimeout(timer));
    // An implementation may finish IO after cancellation. Never touch a newer instance.
    void work
      .finally(() => {
        if (signal.aborted && chat) this.close(chat, key);
      })
      .catch(() => undefined);
  }
  settled(): Promise<void> {
    return this.pending;
  }
}
