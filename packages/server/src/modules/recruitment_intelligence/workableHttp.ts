/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
export function workableObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Workable 响应格式无效');
  return value as Record<string, unknown>;
}
export async function readWorkableJson(response: Response, maxBytes = 2_000_000): Promise<Record<string, unknown>> {
  if (!response.body || Number(response.headers.get('content-length')) > maxBytes) throw new Error('Workable 响应为空或过大');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength; if (size > maxBytes) throw new Error('Workable 响应过大');
      chunks.push(next.value);
    }
    try { return workableObject(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch { throw new Error('Workable 响应不是有效 JSON'); }
  } finally { try { await reader.cancel(); } catch { /* Do not echo provider failures. */ } reader.releaseLock(); }
}
