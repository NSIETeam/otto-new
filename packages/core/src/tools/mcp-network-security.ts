/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Network boundary for remote MCP transports. DNS validation happens inside
 * the socket connector, so the address that is checked is the address used.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';

const MAX_MCP_POST_RESPONSE_BYTES = 2 * 1024 * 1024;

type EndpointLookup = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

function ipv4Number(address: string): number | undefined {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

function inIpv4Cidr(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function ipv6Number(address: string): bigint | undefined {
  const clean = address.toLowerCase().split('%')[0]!;
  const mapped = clean.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  let expanded = clean;
  if (mapped) {
    const ipv4 = ipv4Number(mapped[2]!);
    if (ipv4 === undefined) return undefined;
    expanded = `${mapped[1]}${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  if ((expanded.match(/::/g) ?? []).length > 1) return undefined;
  const [leftRaw, rightRaw] = expanded.split('::');
  const left = leftRaw ? leftRaw.split(':') : [];
  const right = rightRaw ? rightRaw.split(':') : [];
  if (!expanded.includes('::') && left.length !== 8) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (missing === 0 && expanded.includes('::'))) return undefined;
  const parts = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function inIpv6Cidr(value: bigint, base: bigint, prefix: number): boolean {
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (base >> shift);
}

export function isDisallowedMcpAddress(addressInput: string): boolean {
  const address = addressInput.startsWith('[') && addressInput.endsWith(']')
    ? addressInput.slice(1, -1)
    : addressInput;
  if (isIP(address) === 4) {
    const value = ipv4Number(address);
    if (value === undefined) return true;
    const blocked: Array<[string, number]> = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ];
    return blocked.some(([base, prefix]) => inIpv4Cidr(value, ipv4Number(base)!, prefix));
  }
  if (isIP(address) !== 6) return true;
  const value = ipv6Number(address);
  if (value === undefined) return true;
  if (inIpv6Cidr(value, ipv6Number('::ffff:0:0')!, 96)) {
    const hex = Number(value & 0xffff_ffffn).toString(16).padStart(8, '0');
    return isDisallowedMcpAddress(hex.match(/.{2}/g)!.map((part) => Number.parseInt(part, 16)).join('.'));
  }
  if (!inIpv6Cidr(value, ipv6Number('2000::')!, 3)) return true;
  return [
    ['2001:2::', 48], ['2001:10::', 28], ['2001:db8::', 32],
  ].some(([base, prefix]) => inIpv6Cidr(value, ipv6Number(base as string)!, prefix as number));
}

function destinationUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  if (typeof input === 'string') return new URL(input);
  return new URL(input.url);
}

function cappedPostResponse(response: Response): Response {
  if (!(response instanceof Response)) return response;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_MCP_POST_RESPONSE_BYTES) {
    throw new Error('MCP response exceeds the 2MB safety limit');
  }
  if (!response.body) return response;
  let bytes = 0;
  const limited = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MAX_MCP_POST_RESPONSE_BYTES) {
        controller.error(new Error('MCP response exceeds the 2MB safety limit'));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(limited, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export interface McpNetworkGuard {
  fetch: typeof fetch;
  close(): Promise<void>;
}

export interface SafeMcpNetworkResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  text: string;
}

export function createMcpNetworkGuard(
  endpointInput: string | URL,
  lookupImpl: EndpointLookup = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
): McpNetworkGuard {
  const endpoint = new URL(endpointInput);
  if (endpoint.protocol !== 'https:') throw new Error('remote MCP transport requires HTTPS');
  if (endpoint.username || endpoint.password) throw new Error('credentials are forbidden in MCP URL');
  const hostname = endpoint.hostname.startsWith('[') && endpoint.hostname.endsWith(']')
    ? endpoint.hostname.slice(1, -1)
    : endpoint.hostname;
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('localhost MCP endpoint is blocked');
  }
  if (isIP(hostname) && isDisallowedMcpAddress(hostname)) {
    throw new Error('non-public MCP endpoint is blocked');
  }
  const expectedHostname = hostname.toLowerCase();
  const dispatcher = new Agent({
    connect: {
      lookup(requestedHostname, options, callback) {
        if (requestedHostname.toLowerCase() !== expectedHostname) {
          if (options.all) callback(new Error('MCP DNS lookup escaped the configured hostname'), []);
          else callback(new Error('MCP DNS lookup escaped the configured hostname'), '', 4);
          return;
        }
        void lookupImpl(requestedHostname).then((answers) => {
          if (answers.length === 0 || answers.some((answer) => isDisallowedMcpAddress(answer.address))) {
            throw new Error('non-public or mixed DNS answer for MCP endpoint is blocked');
          }
          const family = typeof options.family === 'number' ? options.family : 0;
          const choices = family === 4 || family === 6
            ? answers.filter((answer) => answer.family === family)
            : answers;
          if (choices.length === 0) throw new Error('MCP endpoint has no audited address for requested family');
          if (options.all) callback(null, choices);
          else callback(null, choices[0]!.address, choices[0]!.family);
        }).catch((error: unknown) => {
          const failure = error instanceof Error ? error : new Error(String(error));
          if (options.all) callback(failure, []);
          else callback(failure, '', 4);
        });
      },
    },
  });
  const guardedFetch: typeof fetch = async (input, init) => {
    const destination = destinationUrl(input);
    if (destination.origin !== endpoint.origin) {
      throw new Error('MCP transport attempted a cross-origin request');
    }
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const response = await fetch(input, {
      ...init,
      redirect: 'error',
      dispatcher,
    } as RequestInit);
    return method === 'POST' ? cappedPostResponse(response) : response;
  };
  return { fetch: guardedFetch, close: () => dispatcher.close() };
}

/** One-shot guarded request for OAuth/metadata endpoints; body is bounded and fully consumed. */
export async function fetchMcpNetworkText(
  url: string | URL,
  init: RequestInit = {},
  maxBytes = 512 * 1024,
): Promise<SafeMcpNetworkResponse> {
  const guard = createMcpNetworkGuard(url);
  try {
    const response = await guard.fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(10_000),
    });
    if (!(response instanceof Response)) {
      const mockResponse = response as unknown as {
        ok: boolean;
        status: number;
        statusText?: string;
        headers?: Headers;
        text?: () => Promise<string>;
        json?: () => Promise<unknown>;
      };
      const text = mockResponse.text
        ? await mockResponse.text()
        : JSON.stringify(mockResponse.json ? await mockResponse.json() : null);
      if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        throw new Error(`MCP network response exceeds ${maxBytes} bytes`);
      }
      return {
        ok: mockResponse.ok,
        status: mockResponse.status,
        statusText: mockResponse.statusText ?? '',
        headers: mockResponse.headers ?? new Headers(),
        text,
      };
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`MCP network response exceeds ${maxBytes} bytes`);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      return {
        ok: response.ok, status: response.status, statusText: response.statusText,
        headers: response.headers, text: '',
      };
    }
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel('MCP network response size limit exceeded');
          throw new Error(`MCP network response exceeds ${maxBytes} bytes`);
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    return {
      ok: response.ok, status: response.status, statusText: response.statusText,
      headers: response.headers, text,
    };
  } finally {
    await guard.close();
  }
}
