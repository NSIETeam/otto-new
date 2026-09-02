/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Native MCP catalogue, audit and draft-generation boundary. Registry/GitHub
 * content is always untrusted metadata: this module never installs or executes
 * a discovered server.
 */

import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';

const MAX_CATALOG_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PROBE_RESPONSE_BYTES = 1024 * 1024;
const MAX_PROBE_TOOLS = 512;
const MAX_TOOL_NAME_LENGTH = 128;

export type McpRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type McpPermission =
  | 'filesystem'
  | 'network'
  | 'account_credentials'
  | 'process_execution'
  | 'unknown';

export interface McpEnvironmentVariable {
  name: string;
  required: boolean;
  secret: boolean;
  description?: string;
}

export interface McpSearchCandidate {
  id: string;
  name: string;
  title?: string;
  description: string;
  source: 'official_registry' | 'github';
  version: string;
  repositoryUrl?: string;
  commitSha?: string;
  license?: string;
  packageRegistry?: string;
  packageIdentifier?: string;
  packageVersion?: string;
  remoteUrl?: string;
  environmentVariables: McpEnvironmentVariable[];
  permissions: McpPermission[];
  installed: false;
  trust: false;
}

export interface McpAuditCheck {
  id: 'repository' | 'commit' | 'license' | 'dependencies' | 'command' | 'source';
  label: string;
  status: 'passed' | 'warning' | 'blocked';
  detail: string;
}

export interface McpAuditReport {
  id: string;
  candidateId: string;
  createdAt: string;
  installable: boolean;
  riskLevel: McpRiskLevel;
  checks: McpAuditCheck[];
  permissions: McpPermission[];
  environmentVariables: McpEnvironmentVariable[];
  trust: false;
  probeStatus: 'not_run' | 'passed' | 'failed';
}

export interface McpProbeResult {
  auditId?: string;
  candidateId: string;
  status: 'passed' | 'failed';
  transport: 'streamable_http';
  tools: string[];
  serverName?: string;
  serverVersion?: string;
  detail: string;
}

export interface McpCreatorInput {
  name: string;
  description: string;
  inputKind: 'natural_language' | 'openapi' | 'api_docs' | 'curl';
  sourceText: string;
  transport: 'stdio' | 'streamable_http';
  environmentVariables?: string[];
}

export interface McpDraftOperation {
  name: string;
  method: string;
  path: string;
  summary?: string;
}

export interface McpCreationDraft {
  id: string;
  name: string;
  status: 'draft';
  trust: false;
  transport: 'stdio' | 'streamable_http';
  inputKind: McpCreatorInput['inputKind'];
  operations: McpDraftOperation[];
  files: Array<{ path: string; content: string }>;
  warnings: string[];
}

type JsonRecord = Record<string, unknown>;

export interface PublicMcpEndpoint {
  hostname: string;
  addresses: Array<{ address: string; family: number }>;
}

type EndpointLookup = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function readTextLimited(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`untrusted response is too large (limit ${maxBytes} bytes)`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel('response size limit exceeded');
        throw new Error(`untrusted response is too large (limit ${maxBytes} bytes)`);
      }
      output += decoder.decode(chunk.value, { stream: true });
    }
    return output + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function readJsonLimited(response: Response, maxBytes: number): Promise<unknown> {
  const text = await readTextLimited(response, maxBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('untrusted endpoint returned invalid JSON');
  }
}

function safeName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'otto-mcp-server';
}

function normalizeEnvironmentVariables(pkg: JsonRecord | undefined): McpEnvironmentVariable[] {
  const raw = pkg?.['environmentVariables'] ?? pkg?.['environment_variables'];
  return array(raw).flatMap((entry) => {
    const item = record(entry);
    const name = string(item?.['name']);
    if (!name) return [];
    return [{
      name,
      required: item?.['isRequired'] === true || item?.['required'] === true,
      secret: item?.['isSecret'] !== false && item?.['secret'] !== false,
      ...(string(item?.['description']) ? { description: string(item?.['description']) } : {}),
    }];
  });
}

/** Convert the Registry response into inert candidate records. */
export function normalizeRegistryResponse(payload: unknown): McpSearchCandidate[] {
  const root = record(payload);
  return array(root?.['servers']).flatMap((entry) => {
    const wrapper = record(entry);
    const server = record(wrapper?.['server']) ?? wrapper;
    const name = string(server?.['name']);
    if (!name) return [];
    const version = string(server?.['version']) ?? 'unknown';
    const repository = record(server?.['repository']);
    const pkg = record(array(server?.['packages'])[0]);
    const remote = record(array(server?.['remotes'])[0]);
    const description = string(server?.['description']) ?? 'No description supplied by publisher.';
    return [{
      id: `${name}@${version}`,
      name,
      ...(string(server?.['title']) ? { title: string(server?.['title']) } : {}),
      description,
      source: 'official_registry' as const,
      version,
      ...(string(repository?.['url']) ? { repositoryUrl: string(repository?.['url']) } : {}),
      ...(string(pkg?.['registryType'] ?? pkg?.['registry_type'])
        ? { packageRegistry: string(pkg?.['registryType'] ?? pkg?.['registry_type']) }
        : {}),
      ...(string(pkg?.['identifier'] ?? pkg?.['packageIdentifier'])
        ? { packageIdentifier: string(pkg?.['identifier'] ?? pkg?.['packageIdentifier']) }
        : {}),
      ...(string(pkg?.['version']) ? { packageVersion: string(pkg?.['version']) } : {}),
      ...(string(remote?.['url']) ? { remoteUrl: string(remote?.['url']) } : {}),
      environmentVariables: normalizeEnvironmentVariables(pkg),
      permissions: inferPermissions(description, normalizeEnvironmentVariables(pkg)),
      installed: false as const,
      trust: false as const,
    }];
  });
}

export async function searchOfficialMcpRegistry(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<McpSearchCandidate[]> {
  const clean = query.trim();
  if (!clean) return [];
  const url = new URL('https://registry.modelcontextprotocol.io/v0.1/servers');
  url.searchParams.set('search', clean);
  url.searchParams.set('version', 'latest');
  url.searchParams.set('limit', '20');
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Otto-MCP-Finder/1.0' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`MCP Registry returned HTTP ${response.status}`);
  return normalizeRegistryResponse(await readJsonLimited(response, MAX_CATALOG_RESPONSE_BYTES));
}

export function normalizeGitHubSearchResponse(payload: unknown): McpSearchCandidate[] {
  return array(record(payload)?.['items']).flatMap((entry) => {
    const item = record(entry);
    const name = string(item?.['full_name']);
    const repositoryUrl = string(item?.['html_url']);
    if (!name || !repositoryUrl) return [];
    const description = string(item?.['description']) ?? 'GitHub repository without a description.';
    const license = string(record(item?.['license'])?.['spdx_id']);
    const version = string(item?.['default_branch']) ?? 'HEAD';
    return [{
      id: `github:${name}@${version}`,
      name,
      description,
      source: 'github' as const,
      version,
      repositoryUrl,
      ...(license && license !== 'NOASSERTION' ? { license } : {}),
      environmentVariables: [],
      permissions: inferPermissions(description, []),
      installed: false as const,
      trust: false as const,
    }];
  });
}

export async function searchGitHubMcpRepositories(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<McpSearchCandidate[]> {
  const clean = query.trim();
  if (!clean) return [];
  const url = new URL('https://api.github.com/search/repositories');
  url.searchParams.set('q', `${clean} "mcp server" in:name,description,readme`);
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('per_page', '10');
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Otto-MCP-Finder/1.0' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`GitHub search returned HTTP ${response.status}`);
  return normalizeGitHubSearchResponse(await readJsonLimited(response, MAX_CATALOG_RESPONSE_BYTES));
}

/** Resolve immutable GitHub evidence without downloading or executing code. */
export async function enrichCandidateFromGitHub(
  candidate: McpSearchCandidate,
  fetchImpl: typeof fetch = fetch,
): Promise<McpSearchCandidate> {
  const match = candidate.repositoryUrl?.match(/^https:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?$/i);
  if (!match) return candidate;
  const owner = encodeURIComponent(match[1]!);
  const repo = encodeURIComponent(match[2]!);
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Otto-MCP-Finder/1.0' };
  const repoResponse = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}`, {
    headers,
    signal: AbortSignal.timeout(12_000),
  });
  if (!repoResponse.ok) return candidate;
  const repoMeta = record(await readJsonLimited(repoResponse, MAX_CATALOG_RESPONSE_BYTES));
  const ref = candidate.version !== 'unknown' ? candidate.version : string(repoMeta?.['default_branch']) ?? 'HEAD';
  const commitResponse = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
    { headers, signal: AbortSignal.timeout(12_000) },
  );
  const commitMeta = commitResponse.ok
    ? record(await readJsonLimited(commitResponse, MAX_CATALOG_RESPONSE_BYTES))
    : undefined;
  const license = string(record(repoMeta?.['license'])?.['spdx_id']);
  return {
    ...candidate,
    ...(string(commitMeta?.['sha']) ? { commitSha: string(commitMeta?.['sha']) } : {}),
    ...(license && license !== 'NOASSERTION' ? { license } : {}),
  };
}

function inferPermissions(
  description: string,
  env: McpEnvironmentVariable[],
): McpPermission[] {
  const text = `${description} ${env.map((item) => item.name).join(' ')}`.toLowerCase();
  const permissions = new Set<McpPermission>();
  if (/https?|api|network|web|remote|github|slack|notion|mail|weather/.test(text)) permissions.add('network');
  if (/file|filesystem|folder|directory|workspace|disk/.test(text)) permissions.add('filesystem');
  if (env.some((item) => item.secret) || /token|secret|password|credential|api[_ -]?key/.test(text)) {
    permissions.add('account_credentials');
  }
  if (/shell|command|process|terminal|exec/.test(text)) permissions.add('process_execution');
  if (permissions.size === 0) permissions.add('unknown');
  return [...permissions];
}

function verifiableLicense(value: string | undefined): value is string {
  if (
    !value
    || value.length > 200
    || value.includes('\r')
    || value.includes('\n')
    || value.includes('\0')
  ) return false;
  if (['NOASSERTION', 'UNKNOWN', 'OTHER', 'SEE LICENSE IN README'].includes(value.toUpperCase())) return false;
  return /^[A-Za-z0-9][A-Za-z0-9.+-]*(?:\s+(?:AND|OR|WITH)\s+[A-Za-z0-9][A-Za-z0-9.+-]*)*$/.test(value);
}

export function auditMcpCandidate(candidate: McpSearchCandidate): McpAuditReport {
  const permissions = [...new Set([
    ...candidate.permissions,
    ...inferPermissions(candidate.description, candidate.environmentVariables),
  ])];
  const checks: McpAuditCheck[] = [
    candidate.repositoryUrl
      ? { id: 'repository', label: '源码仓库', status: 'passed', detail: candidate.repositoryUrl }
      : { id: 'repository', label: '源码仓库', status: 'blocked', detail: '发布者未提供可审查的源码仓库。' },
    candidate.commitSha && /^[a-f0-9]{40}$/i.test(candidate.commitSha)
      ? { id: 'commit', label: '不可变提交', status: 'passed', detail: candidate.commitSha }
      : { id: 'commit', label: '不可变提交', status: 'blocked', detail: '尚未固定到 40 位 Git 提交哈希。' },
    verifiableLicense(candidate.license)
      ? { id: 'license', label: '许可证', status: 'passed', detail: candidate.license }
      : { id: 'license', label: '许可证', status: 'blocked', detail: '未获得可验证的 SPDX 许可证标识或表达式。' },
    candidate.remoteUrl
      ? {
          id: 'dependencies',
          label: '依赖漏洞',
          status: 'passed',
          detail: '该候选仅连接固定 HTTPS 远程端点，Otto 不在本机下载或执行其依赖；远端实现仍按未知风险展示。',
        }
      : {
          id: 'dependencies',
          label: '依赖漏洞',
          status: 'blocked',
          detail: '本地 MCP 尚未在隔离环境固定锁文件并完成依赖漏洞与安装脚本审计。',
        },
    candidate.remoteUrl
      ? {
          id: 'command',
          label: '启动命令',
          status: 'passed',
          detail: '使用固定 HTTPS Streamable HTTP 端点，不通过 shell 启动本地进程。',
        }
      : candidate.packageIdentifier || candidate.repositoryUrl
        ? {
            id: 'command',
            label: '启动命令',
            status: 'blocked',
            detail: '本地启动参数尚未固定并验证为无 shell、无远程管道和无浮动下载。',
          }
        : { id: 'command', label: '启动命令', status: 'blocked', detail: '没有可固定的包或启动来源。' },
    { id: 'source', label: '来源声明', status: 'passed', detail: candidate.source === 'official_registry' ? '官方 MCP Registry 元数据（不等于安全背书）' : 'GitHub 搜索结果（不等于安全背书）' },
  ];
  const blocked = checks.some((check) => check.status === 'blocked');
  const highRisk = permissions.includes('process_execution')
    || (permissions.includes('filesystem') && permissions.includes('account_credentials'));
  return {
    id: `mcp-audit-${randomUUID()}`,
    candidateId: candidate.id,
    createdAt: new Date().toISOString(),
    installable: !blocked,
    riskLevel: blocked || highRisk ? 'high' : permissions.includes('account_credentials') ? 'medium' : 'low',
    checks,
    permissions,
    environmentVariables: candidate.environmentVariables,
    trust: false,
    probeStatus: 'not_run',
  };
}

function ipv4Number(address: string): number | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return (((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!) >>> 0;
}

function inIpv4Cidr(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function ipv6Number(address: string): bigint | undefined {
  const clean = address.toLowerCase().split('%')[0]!;
  const mappedIpv4 = clean.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  let expanded = clean;
  if (mappedIpv4) {
    const ipv4 = ipv4Number(mappedIpv4[2]!);
    if (ipv4 === undefined) return undefined;
    expanded = `${mappedIpv4[1]}${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
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

function nonPublicAddress(addressInput: string): boolean {
  const address = addressInput.startsWith('[') && addressInput.endsWith(']')
    ? addressInput.slice(1, -1)
    : addressInput;
  const family = isIP(address);
  if (family === 4) {
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
  if (family !== 6) return true;
  const value = ipv6Number(address);
  if (value === undefined) return true;
  const mappedPrefix = ipv6Number('::ffff:0:0')!;
  if (inIpv6Cidr(value, mappedPrefix, 96)) {
    return nonPublicAddress(Number(value & 0xffff_ffffn)
      .toString(16)
      .padStart(8, '0')
      .match(/.{2}/g)!
      .map((part) => Number.parseInt(part, 16))
      .join('.'));
  }
  const globallyRouted = inIpv6Cidr(value, ipv6Number('2000::')!, 3);
  if (!globallyRouted) return true;
  return [
    ['2001:2::', 48],
    ['2001:10::', 28],
    ['2001:db8::', 32],
  ].some(([base, prefix]) => inIpv6Cidr(value, ipv6Number(base as string)!, prefix as number));
}

/** Resolve and validate every DNS answer before an MCP request is allowed. */
export async function resolvePublicMcpEndpoint(
  url: URL,
  lookupImpl: EndpointLookup = async (hostname) => lookup(hostname, { all: true, verbatim: true }),
): Promise<PublicMcpEndpoint> {
  if (url.protocol !== 'https:') throw new Error('remote MCP probe requires HTTPS');
  if (url.username || url.password) throw new Error('credentials are forbidden in MCP URL');
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('localhost MCP probe is blocked');
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookupImpl(hostname);
  if (addresses.length === 0 || addresses.some((entry) => nonPublicAddress(entry.address))) {
    throw new Error('non-public or unresolved MCP endpoint is blocked');
  }
  return { hostname, addresses };
}

function pinnedEndpointDispatcher(endpoint: PublicMcpEndpoint): Agent {
  const expectedHostname = endpoint.hostname.toLowerCase();
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        if (hostname.toLowerCase() !== expectedHostname) {
          if (options.all) callback(new Error('MCP DNS lookup escaped the audited hostname'), []);
          else callback(new Error('MCP DNS lookup escaped the audited hostname'), '', 4);
          return;
        }
        const requestedFamily = typeof options.family === 'number' ? options.family : 0;
        const choices = requestedFamily === 4 || requestedFamily === 6
          ? endpoint.addresses.filter((entry) => entry.family === requestedFamily)
          : endpoint.addresses;
        if (choices.length === 0) {
          if (options.all) callback(new Error('MCP endpoint has no audited address for the requested family'), []);
          else callback(new Error('MCP endpoint has no audited address for the requested family'), '', 4);
          return;
        }
        if (options.all) {
          callback(null, choices);
          return;
        }
        const selected = choices[0]!;
        callback(null, selected.address, selected.family);
      },
    },
  });
}

function jsonRpcPayload(text: string, expectedId: number): JsonRecord {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('empty MCP response');
  const candidates: JsonRecord[] = [];
  if (trimmed.startsWith('{')) candidates.push(record(JSON.parse(trimmed)) ?? {});
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const value = line.slice(5).trim();
    if (value.startsWith('{')) candidates.push(record(JSON.parse(value)) ?? {});
  }
  const payload = candidates.find((item) => item['id'] === expectedId);
  if (!payload) throw new Error('MCP JSON-RPC response id does not match request');
  if (payload['jsonrpc'] !== '2.0') throw new Error('invalid MCP JSON-RPC protocol version');
  if (payload['error'] !== undefined) throw new Error('MCP JSON-RPC error response');
  if (!record(payload['result'])) throw new Error('MCP JSON-RPC response has no result object');
  return payload;
}

/**
 * No-side-effect remote probe. It rejects local/private endpoints and sends only
 * initialize plus tools/list; it never calls a discovered tool.
 */
export async function probeRemoteMcpCandidate(
  candidate: McpSearchCandidate,
  fetchImpl: typeof fetch = fetch,
  publicEndpointCheck: (url: URL) => Promise<PublicMcpEndpoint> = resolvePublicMcpEndpoint,
): Promise<McpProbeResult> {
  if (!candidate.remoteUrl) throw new Error('candidate has no Streamable HTTP endpoint');
  if (candidate.environmentVariables.some((item) => item.required)) {
    throw new Error('probe with real credentials is forbidden');
  }
  const url = new URL(candidate.remoteUrl);
  const publicEndpoint = await publicEndpointCheck(url);
  const dispatcher = fetchImpl === fetch ? pinnedEndpointDispatcher(publicEndpoint) : undefined;
  const guardedFetch: typeof fetch = dispatcher
    ? ((input, init) => fetch(input, { ...init, dispatcher } as RequestInit))
    : fetchImpl;
  const headers: Record<string, string> = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': '2025-06-18',
  };
  const send = async (method: string, id: number, params?: JsonRecord): Promise<{ payload: JsonRecord; response: Response }> => {
    const response = await guardedFetch(url, {
      method: 'POST',
      redirect: 'error',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`MCP ${method} returned HTTP ${response.status}`);
    return {
      payload: jsonRpcPayload(await readTextLimited(response, MAX_PROBE_RESPONSE_BYTES), id),
      response,
    };
  };
  try {
    const initialized = await send('initialize', 1, {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'otto-mcp-audit-probe', version: '1.0.0' },
    });
    const sessionId = initialized.response.headers.get('mcp-session-id');
    if (sessionId) {
      if (!/^[\x21-\x7e]{1,256}$/.test(sessionId)) throw new Error('invalid MCP session id');
      headers['Mcp-Session-Id'] = sessionId;
    }
    const listed = await send('tools/list', 2, {});
    const initResult = record(initialized.payload['result']);
    const toolResult = record(listed.payload['result']);
    const rawTools = array(toolResult?.['tools']);
    if (rawTools.length > MAX_PROBE_TOOLS) throw new Error('MCP tools/list exceeded tool limit');
    const tools = [...new Set(rawTools.flatMap((value) => {
      const name = string(record(value)?.['name']);
      if (!name) return [];
      if (name.length > MAX_TOOL_NAME_LENGTH) throw new Error('MCP tool name exceeds length limit');
      return [name];
    }))];
    return {
      candidateId: candidate.id,
      status: 'passed',
      transport: 'streamable_http',
      tools,
      ...(string(record(initResult?.['serverInfo'])?.['name']) ? { serverName: string(record(initResult?.['serverInfo'])?.['name']) } : {}),
      ...(string(record(initResult?.['serverInfo'])?.['version']) ? { serverVersion: string(record(initResult?.['serverInfo'])?.['version']) } : {}),
      detail: `initialize 与 tools/list 通过；发现 ${tools.length} 个工具，未调用任何工具。`,
    };
  } finally {
    if (dispatcher) await dispatcher.close();
  }
}

function parseOpenApiOperations(sourceText: string): McpDraftOperation[] {
  try {
    const doc = record(JSON.parse(sourceText));
    const paths = record(doc?.['paths']);
    if (!paths) return [];
    const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
    const operations: McpDraftOperation[] = [];
    for (const [route, value] of Object.entries(paths)) {
      const pathItem = record(value);
      if (!pathItem) continue;
      for (const [method, operationValue] of Object.entries(pathItem)) {
        if (!methods.has(method.toLowerCase())) continue;
        const operation = record(operationValue);
        const operationId = string(operation?.['operationId'])
          ?? `${method}-${route}`.replace(/[^a-zA-Z0-9]+(.)/g, (_, ch: string) => ch.toUpperCase());
        operations.push({
          name: operationId,
          method: method.toUpperCase(),
          path: route,
          ...(string(operation?.['summary']) ? { summary: string(operation?.['summary']) } : {}),
        });
      }
    }
    return operations;
  } catch {
    return [];
  }
}

function sourceForDraft(
  name: string,
  operations: McpDraftOperation[],
  transport: McpCreatorInput['transport'],
): string {
  const registrations = operations.length > 0
    ? operations.map((operation) => {
        const readOnly = operation.method === 'GET' || operation.method === 'HEAD' || operation.method === 'OPTIONS';
        return `server.registerTool(\n    ${JSON.stringify(operation.name)},\n    {\n      description: ${JSON.stringify(operation.summary ?? `${operation.method} ${operation.path}`)},\n      inputSchema: z.object({}),\n      outputSchema: z.object({ status: z.literal('draft'), operation: z.string() }),\n      annotations: {\n        readOnlyHint: ${readOnly},\n        destructiveHint: ${!readOnly},\n        idempotentHint: ${readOnly},\n        openWorldHint: true,\n      },\n    },\n    async () => ({\n      content: [{ type: 'text', text: 'Adapter implementation required before installation.' }],\n      structuredContent: { status: 'draft', operation: ${JSON.stringify(`${operation.method} ${operation.path}`)} },\n    }),\n  );`;
      }).join('\n\n')
    : `server.registerTool(\n    'health_check',\n    {\n      description: 'Read-only connectivity check',\n      inputSchema: z.object({}),\n      outputSchema: z.object({ status: z.literal('ok') }),\n      annotations: {\n        readOnlyHint: true,\n        destructiveHint: false,\n        idempotentHint: true,\n        openWorldHint: false,\n      },\n    },\n    async () => ({\n      content: [{ type: 'text', text: 'ok' }],\n      structuredContent: { status: 'ok' },\n    }),\n  );`;
  const imports = transport === 'stdio'
    ? `import { McpServer } from '@modelcontextprotocol/server';\nimport { StdioServerTransport } from '@modelcontextprotocol/server/stdio';\nimport * as z from 'zod/v4';`
    : `import { createServer } from 'node:http';\nimport { createMcpHandler, McpServer } from '@modelcontextprotocol/server';\nimport { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';\nimport * as z from 'zod/v4';`;
  const common = `${imports}\n\nfunction buildServer(): McpServer {\n  const server = new McpServer(\n    { name: ${JSON.stringify(name)}, version: '0.1.0' },\n    { capabilities: { tools: {}, resources: {}, prompts: {} } },\n  );\n\n  // No resources or prompts are exposed until their data and authorization model is reviewed.\n  ${registrations}\n\n  return server;\n}\n`;
  if (transport === 'stdio') {
    return `${common}\nconst server = buildServer();\nconst transport = new StdioServerTransport();\nawait server.connect(transport);\n`;
  }
  return `${common}\nconst handler = createMcpHandler(() => buildServer(), { responseMode: 'json' });\nconst nodeHandler = toNodeHandler(handler);\nconst validateHost = localhostHostValidation();\nconst validateOrigin = localhostOriginValidation();\nconst port = Number(process.env.MCP_PORT ?? 3000);\n\ncreateServer((request, response) => {\n  if (!validateHost(request, response) || !validateOrigin(request, response)) return;\n  void nodeHandler(request, response);\n}).listen(port, '127.0.0.1', () => {\n  console.error(\`MCP draft listening on http://127.0.0.1:\${port}/mcp\`);\n});\n`;
}

/** Generate an inert preview; the caller decides whether to write the draft directory. */
export function generateTypeScriptMcpDraft(input: McpCreatorInput): McpCreationDraft {
  if (!input.name.trim() || input.name.length > 100) throw new Error('invalid MCP draft name');
  if (!input.description.trim() || input.description.length > 2_000) throw new Error('invalid MCP draft description');
  if (!input.sourceText.trim() || Buffer.byteLength(input.sourceText, 'utf8') > 2_000_000) {
    throw new Error('MCP draft source is empty or exceeds 2MB');
  }
  if ((input.environmentVariables?.length ?? 0) > 64) {
    throw new Error('MCP draft has too many environment variables');
  }
  const name = safeName(input.name);
  const env = [...new Set((input.environmentVariables ?? []).map((item) => item.trim()).filter((item) => /^[A-Z][A-Z0-9_]*$/.test(item)))];
  const operations = input.inputKind === 'openapi' ? parseOpenApiOperations(input.sourceText) : [];
  if (operations.length > 256) throw new Error('MCP draft operation limit exceeded');
  const sourceHash = createHash('sha256').update(input.sourceText).digest('hex');
  const files = [
    {
      path: 'package.json',
      content: JSON.stringify({
        name: `@otto-mcp/${name}`,
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: { build: 'tsc -p tsconfig.json', test: 'vitest run', start: 'node dist/index.js', 'test:connection': 'vitest run tests/connection.test.ts' },
        dependencies: {
          '@modelcontextprotocol/server': '^2.0.0',
          ...(input.transport === 'streamable_http' ? { '@modelcontextprotocol/node': '^2.0.0' } : {}),
          zod: '^4.0.0',
        },
        devDependencies: {
          '@types/node': '^22.0.0',
          typescript: '^5.9.0',
          vitest: '^3.2.0',
        },
      }, null, 2) + '\n',
    },
    {
      path: 'tsconfig.json',
      content: JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          outDir: 'dist',
          rootDir: 'src',
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          esModuleInterop: true,
        },
        include: ['src/**/*.ts'],
      }, null, 2) + '\n',
    },
    { path: 'src/index.ts', content: sourceForDraft(name, operations, input.transport) },
    {
      path: 'server.json',
      content: JSON.stringify({
        $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
        name: `io.github.otto-draft/${name}`,
        title: input.name.trim(),
        description: input.description.trim(),
        version: '0.1.0',
        packages: [{ registryType: 'npm', identifier: `@otto-mcp/${name}`, version: '0.1.0', transport: { type: input.transport === 'stdio' ? 'stdio' : 'streamable-http' }, environmentVariables: env.map((item) => ({ name: item, isRequired: true, isSecret: true })) }],
      }, null, 2) + '\n',
    },
    { path: '.env.example', content: env.map((item) => `${item}=`).join('\n') + (env.length ? '\n' : '') },
    { path: 'README.md', content: `# ${input.name.trim()}\n\n${input.description.trim()}\n\nGenerated as an untrusted Otto draft. Review source, license, dependencies, permissions and tests before installation.\n\nSource input SHA-256: \`${sourceHash}\`\n` },
    { path: 'tests/server.test.ts', content: `import { describe, expect, it } from 'vitest';\n\ndescribe('${name}', () => {\n  it('requires generated adapters to be reviewed', () => { expect(true).toBe(true); });\n});\n` },
    { path: 'tests/connection.test.ts', content: `import { describe, it } from 'vitest';\n\ndescribe('MCP connection', () => {\n  it.todo('initialize and tools/list in an isolated process; never call tools in this test');\n});\n` },
  ];
  return {
    id: `mcp-draft-${randomUUID()}`,
    name,
    status: 'draft',
    trust: false,
    transport: input.transport,
    inputKind: input.inputKind,
    operations,
    files,
    warnings: [
      '草稿不会自动安装或执行。',
      '生成的 API 适配代码必须由开发者补全并审查。',
      '环境变量文件只包含变量名；密钥值不得写入源码或普通设置。',
    ],
  };
}

export async function saveMcpCreationDraft(
  draft: McpCreationDraft,
  draftRoot: string,
): Promise<{ draftId: string; directory: string }> {
  await mkdir(draftRoot, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(draftRoot);
  if (rootStat.isSymbolicLink()) throw new Error('MCP draft root must not be a symbolic link');
  const root = resolve(draftRoot);
  const canonicalRoot = await realpath(draftRoot);
  if (process.platform === 'win32'
    ? canonicalRoot.toLowerCase() !== root.toLowerCase()
    : canonicalRoot !== root) {
    throw new Error('MCP draft root resolves through a link or alias');
  }
  if (!/^mcp-draft-[0-9a-f-]{36}$/i.test(draft.id)) {
    throw new Error('invalid MCP draft id');
  }
  if (draft.files.length === 0 || draft.files.length > 64) {
    throw new Error('MCP draft has too many files or no files');
  }
  const draftPaths = new Set<string>();
  let totalBytes = 0;
  for (const file of draft.files) {
    if (
      !file.path
      || file.path.length > 240
      || isAbsolute(file.path)
      || file.path.split(/[\\/]/).includes('..')
      || file.path === 'draft-manifest.json'
    ) {
      throw new Error(`invalid MCP draft file path: ${file.path}`);
    }
    const normalizedPath = file.path.replace(/\\/g, '/').toLowerCase();
    if (draftPaths.has(normalizedPath)) throw new Error(`duplicate MCP draft file path: ${file.path}`);
    draftPaths.add(normalizedPath);
    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes > 2_000_000) throw new Error(`MCP draft file is too large: ${file.path}`);
    totalBytes += bytes;
    if (totalBytes > 10_000_000) throw new Error('MCP draft total file size limit exceeded');
  }
  const directory = resolve(draftRoot, draft.id);
  if (!directory.startsWith(`${root}${sep}`)) throw new Error('MCP draft path escaped draft root');
  await mkdir(directory, { recursive: false, mode: 0o700 });
  for (const file of draft.files) {
    const target = resolve(directory, file.path);
    if (!target.startsWith(`${directory}${sep}`)) throw new Error('MCP draft file escaped draft directory');
    await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
    await writeFile(target, file.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }
  await writeFile(
    resolve(directory, 'draft-manifest.json'),
    JSON.stringify({
      id: draft.id,
      name: draft.name,
      status: draft.status,
      trust: false,
      transport: draft.transport,
      files: draft.files.map((file) => file.path),
      createdAt: new Date().toISOString(),
    }, null, 2) + '\n',
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  return { draftId: draft.id, directory };
}
