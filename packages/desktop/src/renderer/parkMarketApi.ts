/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { MarketDesktopRequest } from '../shared/park-market.js';
export async function marketRequest<T>(
  path: string,
  method: MarketDesktopRequest['method'] = 'GET',
  body?: Record<string, unknown>,
  imageBase64?: string,
  uploadId?: string,
): Promise<T> {
  if (!window.otto.enterpriseParkMarket)
    throw new Error('当前客户端尚未连接市场服务');
  return (await window.otto.enterpriseParkMarket({
    path,
    method,
    body,
    imageBase64,
    ...(uploadId ? { uploadId } : {}),
  })) as T;
}
