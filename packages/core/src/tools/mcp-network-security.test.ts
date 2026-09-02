/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpNetworkGuard, fetchMcpNetworkText, isDisallowedMcpAddress } from './mcp-network-security.js';

afterEach(() => vi.unstubAllGlobals());

describe('remote MCP runtime network boundary', () => {
  it.each([
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.31.0.1', '192.168.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1',
  ])('classifies non-public address %s as blocked', (address) => {
    expect(isDisallowedMcpAddress(address)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111'])(
    'allows globally routed address %s',
    (address) => expect(isDisallowedMcpAddress(address)).toBe(false),
  );

  it.each([
    'http://mcp.example.com/mcp',
    'https://user:pass@mcp.example.com/mcp',
    'https://localhost/mcp',
    'https://127.0.0.1/mcp',
    'https://[::ffff:127.0.0.1]/mcp',
  ])('rejects unsafe transport configuration before connecting: %s', (url) => {
    expect(() => createMcpNetworkGuard(url)).toThrow(/HTTPS|credentials|localhost|public|blocked/i);
  });

  it('rejects cross-origin requests before DNS or network access', async () => {
    let lookups = 0;
    const guard = createMcpNetworkGuard('https://mcp.example.com/mcp', async () => {
      lookups += 1;
      return [{ address: '93.184.216.34', family: 4 }];
    });
    try {
      await expect(guard.fetch('https://attacker.example.net/collect')).rejects.toThrow(/cross-origin/i);
      expect(lookups).toBe(0);
    } finally {
      await guard.close();
    }
  });

  it('blocks OAuth metadata SSRF and oversized one-shot responses', async () => {
    await expect(fetchMcpNetworkText('https://169.254.169.254/latest/meta-data'))
      .rejects.toThrow(/public|blocked/i);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(524_289), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    await expect(fetchMcpNetworkText('https://8.8.8.8/oauth-metadata'))
      .rejects.toThrow(/exceeds|bytes|large/i);
  });
});
