/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { downloadSource, HEIC_SOURCE_INPUTS, verifyDownload } from '../heic-corresponding-source.mjs';

const spec = HEIC_SOURCE_INPUTS.find(input => input.file === 'GNU-LGPL-3.0.txt');
const bytes = Buffer.from(readFileSync(new URL('../licenses/GNU-LGPL-3.0.txt', import.meta.url), 'utf8').replaceAll('\r\n', '\n'));
const identity = `${spec.file} (www.gnu.org)`;

describe('pinned source HTTP representation handling', () => {
  it.each([['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]])(
    'verifies exact decoded bytes with actual Node Fetch %s decoding', async (encoding, compress) => {
      expect(verifyDownload(bytes, spec)).toEqual(bytes);
      const wire = compress(bytes);
      expect(wire.length).not.toBe(spec.bytes);
      let receivedEncoding;
      const server = createServer((request, response) => {
        receivedEncoding = request.headers['accept-encoding'];
        response.writeHead(200, { 'Content-Encoding': encoding, 'Content-Length': String(wire.length) });
        response.end(wire);
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      try {
        // Only this injected test adapter uses loopback HTTP. The production
        // downloader still requires the original allowlisted HTTPS source.
        const result = await downloadSource(spec, (_url, options) => fetch(
          `http://127.0.0.1:${server.address().port}/`, options,
        ));
        expect(result).toEqual(bytes);
        expect(receivedEncoding).toBe('identity');
      } finally {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    },
  );

  it('accepts exact identity and headerless bodies only after byte/hash verification', async () => {
    for (const headers of [{}, { 'content-length': String(spec.bytes) }, { 'content-encoding': 'identity', 'content-length': String(spec.bytes) }]) {
      await expect(downloadSource(spec, async () => new Response(bytes, { headers }))).resolves.toEqual(bytes);
    }
  });

  it.each(['-1', '7652.0', '7.652e3', 'junk', '67108865'])('rejects malformed or excessive declared length %s', async length => {
    const response = new Response(bytes, { headers: { 'content-length': length, 'content-encoding': 'gzip' } });
    await expect(downloadSource(spec, async () => response)).rejects.toThrow('source content length invalid');
    expect(response.bodyUsed).toBe(true);
  });

  it('rejects an identity length mismatch and cancels the unread body', async () => {
    const response = new Response(bytes, { headers: { 'content-length': String(spec.bytes - 1) } });
    await expect(downloadSource(spec, async () => response)).rejects.toThrow(`source content length mismatch: ${identity}`);
    expect(response.bodyUsed).toBe(true);
  });

  it.each(['zstd', 'gzip, br', 'untrusted-private-value'])('rejects unsupported encoding without echoing its value (%s)', async encoding => {
    const response = new Response(bytes, { headers: { 'content-encoding': encoding } });
    await expect(downloadSource(spec, async () => response)).rejects.toThrow(`source content encoding unsupported: ${identity}`);
    expect(response.bodyUsed).toBe(true);
  });

  it('rejects oversized, truncated, and same-length corrupted decoded bodies despite a short encoded length', async () => {
    const corrupt = Buffer.from(bytes);
    corrupt[0] ^= 1;
    for (const [body, reason] of [
      [Buffer.concat([bytes, Buffer.from('x')]), 'source download exceeded bound'],
      [bytes.subarray(1), 'source archive length mismatch'],
      [corrupt, 'source archive hash mismatch'],
    ]) {
      await expect(downloadSource(spec, async () => new Response(body, {
        headers: { 'content-encoding': 'gzip', 'content-length': '1' },
      }))).rejects.toThrow(`${reason}: ${identity}`);
    }
  });

  it('does not print signed redirect queries or response diagnostics on a representation failure', async () => {
    let calls = 0;
    const fetcher = async () => ++calls === 1
      ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/pinned?signature=must-not-log' } })
      : new Response(bytes, { headers: { 'content-length': '1' }, statusText: 'must-not-log' });
    await expect(downloadSource(spec, fetcher)).rejects.toThrow(
      `source content length mismatch: ${spec.file} (release-assets.githubusercontent.com)`,
    );
    expect(calls).toBe(2);
  });

  it('sanitizes an actual body-reader exception instead of exposing upstream diagnostics', async () => {
    const response = new Response(new ReadableStream({
      start(controller) { controller.error(new Error('private-token and upstream response body')); },
    }), { headers: { 'content-encoding': 'gzip', 'content-length': '1' } });
    const error = await downloadSource(spec, async () => response).catch(caught => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(`source response could not be read: ${identity}`);
    expect(error.cause).toBeUndefined();
    expect(error.stack).not.toContain('private-token');
  });
});
