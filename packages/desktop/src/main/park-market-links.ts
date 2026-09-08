/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
function serverUrl(input: string): string {
  const url = new URL(input);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
  )
    throw new Error('企业服务器地址无效');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
export function marketLink(server: string, listingId: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(listingId))
    throw new Error('商品链接无效');
  return `otto://market/${listingId}?server=${encodeURIComponent(serverUrl(server))}`;
}
/** Links never change accounts or servers; normal detail authorization remains mandatory. */
export class MarketLinkIntents {
  private pending: { server: string; listingId: string } | null = null;
  private reportedMismatch = false;
  accept(input: string): boolean {
    try {
      if (input.length > 3000) return false;
      const url = new URL(input);
      if (
        url.protocol !== 'otto:' ||
        url.host !== 'market' ||
        url.username ||
        url.password ||
        url.hash ||
        !/^\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname) ||
        [...url.searchParams.keys()].join(',') !== 'server'
      )
        return false;
      this.pending = {
        server: serverUrl(url.searchParams.get('server')!),
        listingId: url.pathname.slice(1),
      };
      this.reportedMismatch = false;
      return true;
    } catch {
      return false;
    }
  }
  take(server: string): { listingId: string } | { error: string } | null {
    if (!this.pending) return null;
    if (serverUrl(server) !== this.pending.server) {
      if (this.reportedMismatch) return null;
      this.reportedMismatch = true;
      return { error: '请登录分享链接所属的企业服务器后重试' };
    }
    const result = { listingId: this.pending.listingId };
    this.pending = null;
    return result;
  }
}
