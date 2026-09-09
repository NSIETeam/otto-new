/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
export interface MarketUploadProgress {
  uploadId: string;
  loaded: number;
  total: number;
}
export class MarketUploadManager {
  private active = new Map<
    string,
    { scope: string; controller: AbortController }
  >();
  constructor(
    private currentScope: () => string,
    private request: (
      input: unknown,
      options: {
        signal: AbortSignal;
        onProgress: (loaded: number, total: number) => void;
      },
    ) => Promise<unknown>,
  ) {}
  async start(
    id: string,
    input: unknown,
    report: (progress: MarketUploadProgress) => void,
  ) {
    const scope = this.currentScope();
    if (!scope || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
      throw new Error('图片上传身份无效');
    if (this.active.has(id) || this.active.size >= 9)
      throw new Error('图片正在上传，请稍后重试');
    const record = { scope, controller: new AbortController() };
    this.active.set(id, record);
    try {
      const result = await this.request(input, {
        signal: record.controller.signal,
        onProgress: (loaded, total) => {
          if (this.currentScope() !== scope) {
            record.controller.abort();
            return;
          }
          if (!record.controller.signal.aborted)
            report({ uploadId: id, loaded, total });
        },
      });
      if (this.currentScope() !== scope || record.controller.signal.aborted)
        throw new Error('图片上传已取消或账号已切换');
      return result;
    } finally {
      if (this.active.get(id) === record) this.active.delete(id);
    }
  }
  cancel(id: string) {
    const record = this.active.get(id);
    if (record && record.scope === this.currentScope()) {
      record.controller.abort();
      return true;
    }
    return false;
  }
  cancelAll() {
    for (const record of this.active.values()) record.controller.abort();
  }
}
