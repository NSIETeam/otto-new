/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { convert } from 'html-to-text';
import { safeFetchPublicUrl } from './web-fetch-security.js';
import type { WebSourceReceipt } from './tools.js';
function publicEvidenceUri(uri: string): string {
  const parsed = new URL(uri);
  if (
    uri.length > 4096 ||
    parsed.username ||
    parsed.password ||
    [...parsed.searchParams.keys()].some((key) =>
      /token|key|secret|signature|auth|password/iu.test(key),
    )
  )
    throw new Error(
      'Source evidence requires a public URL without credential query parameters',
    );
  parsed.hash = '';
  return parsed.href;
}

/** Fetch bytes, never a model summary. Reuses the public-web redirect/SSRF gate.
 * This proves retrieval only, NOT publisher identity, freshness or truth. */
export async function fetchSourceEvidence(
  uri: string,
  signal: AbortSignal,
): Promise<WebSourceReceipt> {
  uri = publicEvidenceUri(uri);
  const timeout = AbortSignal.timeout(10000);
  const abort = AbortSignal.any([signal, timeout]);
  const response = await safeFetchPublicUrl(uri, {
    signal: abort,
    timeoutMs: 10000,
  });
  if (!response.ok)
    throw new Error(`Source fetch failed: HTTP ${response.status}`);
  const type = response.headers.get('content-type') ?? '';
  if (
    !/^(?:text\/(?:html|plain)|application\/(?:json|xhtml\+xml))(?:;|$)/iu.test(
      type,
    )
  ) {
    await response.body?.cancel();
    throw new Error(
      'Evidence fetch requires HTML, plain text or JSON; binary content is not source text',
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty source body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      abort.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 1024 * 1024)
        throw new Error(
          'Source exceeds 1 MB evidence limit; use a smaller original source',
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const extracted = /html/iu.test(type)
    ? convert(raw, {
        wordwrap: false,
        selectors: [
          { selector: 'a', options: { ignoreHref: true } },
          { selector: 'img', format: 'skip' },
          { selector: 'script', format: 'skip' },
          { selector: 'style', format: 'skip' },
        ],
      })
    : raw;
  const text = extracted.slice(0, 12000);
  if (!text.trim()) throw new Error('Source contains no readable text');
  return {
    uri: publicEvidenceUri(response.url || uri),
    text,
    sha256: createHash('sha256').update(text).digest('hex'),
    retrievedAt: new Date().toISOString(),
    truncated: extracted.length > text.length,
  };
}
