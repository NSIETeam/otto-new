import type { IncomingMessage } from 'node:http';

/** `complete` describes reception, not consumption of Node's buffered stream. */
export async function readEnterpriseRequestBody(req: IncomingMessage, maxLength = 1_000_000): Promise<Record<string, unknown>> {
  if (req.readableEnded) return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxLength) { chunks.length = 0; continue; }
    chunks.push(bytes);
  }
  if (size > maxLength || !size) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}
