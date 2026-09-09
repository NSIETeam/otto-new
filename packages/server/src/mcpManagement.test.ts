/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auditMcpCandidate,
  generateTypeScriptMcpDraft,
  normalizeGitHubSearchResponse,
  normalizeRegistryResponse,
  probeRemoteMcpCandidate,
  resolvePublicMcpEndpoint,
  searchOfficialMcpRegistry,
  saveMcpCreationDraft,
} from './mcpManagement.js';

const writeBoundary = vi.hoisted(() => ({ afterClose: undefined as (() => void) | undefined }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    closeSync(fd: number) {
      actual.closeSync(fd);
      // Windows refuses renaming an ancestor while its file is open. Perform
      // the real filesystem swap immediately after close, before the caller's
      // awaited save resumes; all reads/writes and identity checks remain real.
      const mutate = writeBoundary.afterClose;
      writeBoundary.afterClose = undefined;
      mutate?.();
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  writeBoundary.afterClose = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('MCP management safety boundary', () => {
  it('normalizes official Registry metadata without treating it as installed or trusted', () => {
    const candidates = normalizeRegistryResponse({
      servers: [
        {
          server: {
            name: 'io.github.example/weather',
            title: 'Weather MCP',
            description: 'Reads a weather API',
            version: '1.2.3',
            repository: {
              url: 'https://github.com/example/weather-mcp',
              source: 'github',
            },
            packages: [
              {
                registryType: 'npm',
                identifier: '@example/weather-mcp',
                version: '1.2.3',
                environmentVariables: [{ name: 'WEATHER_API_KEY', isRequired: true, isSecret: true }],
              },
            ],
          },
          _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
        },
      ],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: 'io.github.example/weather@1.2.3',
      source: 'official_registry',
      repositoryUrl: 'https://github.com/example/weather-mcp',
      version: '1.2.3',
      installed: false,
      trust: false,
      environmentVariables: [
        { name: 'WEATHER_API_KEY', required: true, secret: true },
      ],
    });
  });

  it('blocks installation when source, immutable revision, or license evidence is missing', () => {
    const report = auditMcpCandidate({
      id: 'candidate@latest',
      name: 'candidate',
      description: 'Can read local files and call a remote API',
      source: 'official_registry',
      version: 'latest',
      installed: false,
      trust: false,
      environmentVariables: [{ name: 'TOKEN', required: true, secret: true }],
      permissions: [],
    });

    expect(report.installable).toBe(false);
    expect(report.riskLevel).toBe('high');
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'repository', status: 'blocked' }),
        expect.objectContaining({ id: 'commit', status: 'blocked' }),
        expect.objectContaining({ id: 'license', status: 'blocked' }),
      ]),
    );
    expect(report.permissions).toEqual(
      expect.arrayContaining(['network', 'filesystem', 'account_credentials']),
    );
  });

  it('blocks local package candidates until dependency and no-shell command checks are complete', () => {
    const report = auditMcpCandidate({
      id: 'local@1.0.0',
      name: 'local',
      description: 'Local stdio MCP package',
      source: 'official_registry',
      version: '1.0.0',
      repositoryUrl: 'https://github.com/example/local-mcp',
      commitSha: 'b'.repeat(40),
      license: 'MIT',
      packageRegistry: 'npm',
      packageIdentifier: '@example/local-mcp',
      packageVersion: '1.0.0',
      environmentVariables: [],
      permissions: ['process_execution'],
      installed: false,
      trust: false,
    });

    expect(report.installable).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'dependencies', status: 'blocked' }),
      expect.objectContaining({ id: 'command', status: 'blocked' }),
    ]));
  });

  it('does not claim to scan remote service dependencies that are never installed locally', () => {
    const report = auditMcpCandidate({
      id: 'remote@1.0.0',
      name: 'remote',
      description: 'Public read-only remote MCP',
      source: 'official_registry',
      version: '1.0.0',
      repositoryUrl: 'https://github.com/example/remote-mcp',
      commitSha: 'c'.repeat(40),
      license: 'Apache-2.0',
      remoteUrl: 'https://mcp.example.com/mcp',
      environmentVariables: [],
      permissions: ['network'],
      installed: false,
      trust: false,
    });

    expect(report.installable).toBe(true);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'dependencies', status: 'passed' }),
      expect.objectContaining({ id: 'command', status: 'passed' }),
    ]));
  });

  it.each(['NOASSERTION', 'UNKNOWN', 'OTHER', 'SEE LICENSE IN README', 'MIT\nmalicious']) (
    'does not treat an unverifiable license label as passed: %s',
    (license) => {
      const report = auditMcpCandidate({
        ...safeRemoteCandidate(),
        license,
      });
      expect(report.installable).toBe(false);
      expect(report.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'license', status: 'blocked' }),
      ]));
    },
  );

  it('keeps GitHub search results as untrusted candidates', () => {
    const [candidate] = normalizeGitHubSearchResponse({
      items: [{
        full_name: 'example/calendar-mcp',
        html_url: 'https://github.com/example/calendar-mcp',
        description: 'Calendar MCP server',
        default_branch: 'main',
        license: { spdx_id: 'MIT' },
      }],
    });
    expect(candidate).toMatchObject({
      source: 'github',
      repositoryUrl: 'https://github.com/example/calendar-mcp',
      license: 'MIT',
      trust: false,
      installed: false,
    });
    expect(candidate?.commitSha).toBeUndefined();
  });

  it('generates a draft only, with no secrets and trust disabled', () => {
    const draft = generateTypeScriptMcpDraft({
      name: 'acme-orders',
      description: 'Query Acme orders',
      inputKind: 'openapi',
      sourceText: JSON.stringify({
        openapi: '3.1.0',
        paths: {
          '/orders/{id}': {
            get: { operationId: 'getOrder', summary: 'Get an order' },
          },
        },
      }),
      transport: 'stdio',
      environmentVariables: ['ACME_API_KEY'],
    });

    expect(draft.status).toBe('draft');
    expect(draft.trust).toBe(false);
    expect(draft.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        'package.json',
        'tsconfig.json',
        'src/index.ts',
        'server.json',
        'README.md',
        '.env.example',
        'tests/server.test.ts',
        'tests/connection.test.ts',
      ]),
    );
    expect(draft.files.find((file) => file.path === '.env.example')?.content)
      .toBe('ACME_API_KEY=\n');
    expect(JSON.stringify(draft)).not.toContain('trust":true');
    expect(draft.operations).toEqual([
      expect.objectContaining({ name: 'getOrder', method: 'GET', path: '/orders/{id}' }),
    ]);
    const generatedSource = draft.files.find((file) => file.path === 'src/index.ts')?.content ?? '';
    const generatedPackage = draft.files.find((file) => file.path === 'package.json')?.content ?? '';
    expect(generatedSource).toContain('readOnlyHint: true');
    expect(generatedSource).toContain('destructiveHint: false');
    expect(generatedSource).toContain('outputSchema');
    expect(generatedSource).toContain("from '@modelcontextprotocol/server'");
    expect(generatedPackage).toContain('"@modelcontextprotocol/server": "^2.0.0"');
    expect(generatedPackage).not.toContain('@modelcontextprotocol/sdk');
  });

  it('generates a loopback Streamable HTTP entry with host and origin validation', () => {
    const draft = generateTypeScriptMcpDraft({
      name: 'remote-orders',
      description: 'Remote order lookup',
      inputKind: 'natural_language',
      sourceText: 'Expose a read-only order lookup tool',
      transport: 'streamable_http',
    });
    const source = draft.files.find((file) => file.path === 'src/index.ts')?.content ?? '';
    const pkg = draft.files.find((file) => file.path === 'package.json')?.content ?? '';

    expect(source).toContain('createMcpHandler');
    expect(source).toContain('localhostHostValidation');
    expect(source).toContain('localhostOriginValidation');
    expect(source).toContain("listen(port, '127.0.0.1',");
    expect(source).not.toContain('StdioServerTransport');
    expect(pkg).toContain('"@modelcontextprotocol/node": "^2.0.0"');
  });

  it('writes a confirmed draft only inside the isolated MCP draft root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'otto-mcp-draft-'));
    roots.push(root);
    const draft = generateTypeScriptMcpDraft({
      name: 'safe-draft',
      description: 'Read-only test',
      inputKind: 'natural_language',
      sourceText: 'Create one read-only health tool',
      transport: 'stdio',
    });

    const saved = await saveMcpCreationDraft(draft, root);

    expect(saved.directory.startsWith(root)).toBe(true);
    expect(readFileSync(join(saved.directory, 'server.json'), 'utf8')).toContain('safe-draft');
    expect(readFileSync(join(saved.directory, 'draft-manifest.json'), 'utf8')).toContain('"trust": false');
  });

  it.each([false, true])('accepts a pinned host parent alias with a missing root: %s', async (missingRoot) => {
    const parent = mkdtempSync(join(tmpdir(), 'otto-mcp-host-alias-'));
    roots.push(parent);
    const host = join(parent, 'host');
    const alias = join(parent, 'alias');
    mkdirSync(host);
    symlinkSync(host, alias, 'junction');
    if (!missingRoot) mkdirSync(join(host, 'drafts'));
    const draft = simpleDraft();

    const saved = await saveMcpCreationDraft(draft, join(alias, 'drafts'));

    expect(realpathSync(saved.directory)).toBe(realpathSync(join(host, 'drafts', draft.id)));
    expect(readFileSync(join(saved.directory, 'draft-manifest.json'), 'utf8')).toContain('"trust": false');
  });

  it('rejects a same-path root inode replacement across a write await', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'otto-mcp-root-swap-'));
    roots.push(parent);
    const root = join(parent, 'drafts');
    mkdirSync(root);
    const draft = simpleDraft();
    writeBoundary.afterClose = () => {
      renameSync(root, join(parent, 'original'));
      mkdirSync(root);
    };
    const saving = saveMcpCreationDraft(draft, root);

    await expect(saving).rejects.toThrow(/identity|changed|root/i);
    expect(existsSync(join(root, draft.id))).toBe(false);
    expect(existsSync(join(parent, 'original', draft.id, 'draft-manifest.json'))).toBe(false);
  });

  it('rejects retargeting the trusted host alias across a write await', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'otto-mcp-alias-swap-'));
    roots.push(parent);
    const host = join(parent, 'host');
    const outside = join(parent, 'outside');
    const alias = join(parent, 'alias');
    mkdirSync(join(host, 'drafts'), { recursive: true });
    mkdirSync(join(outside, 'drafts'), { recursive: true });
    symlinkSync(host, alias, 'junction');
    const draft = simpleDraft();
    const saving = saveMcpCreationDraft(draft, join(alias, 'drafts'));
    renameSync(alias, join(parent, 'original-alias'));
    symlinkSync(outside, alias, 'junction');

    await expect(saving).rejects.toThrow(/identity|changed|root/i);
    expect(existsSync(join(outside, 'drafts', draft.id))).toBe(false);
    expect(existsSync(join(host, 'drafts', draft.id, 'draft-manifest.json'))).toBe(false);
  });

  it.each(['link', 'directory'])('rejects a draft descendant %s replacement across a write await', async (replacement) => {
    const parent = mkdtempSync(join(tmpdir(), 'otto-mcp-descendant-swap-'));
    roots.push(parent);
    const root = join(parent, 'drafts');
    const outside = join(parent, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    const draft = simpleDraft();
    draft.files = [
      { path: 'src/first.txt', content: 'first' },
      { path: 'src/second.txt', content: 'second' },
    ];
    const child = join(root, draft.id, 'src');
    writeBoundary.afterClose = () => {
      renameSync(child, join(root, draft.id, 'original-src'));
      if (replacement === 'link') symlinkSync(outside, child, 'junction');
      else mkdirSync(child);
    };
    const saving = saveMcpCreationDraft(draft, root);

    await expect(saving).rejects.toThrow(/identity|changed|link/i);
    expect(existsSync(join(child, 'second.txt'))).toBe(false);
    expect(existsSync(join(outside, 'second.txt'))).toBe(false);
    expect(existsSync(join(root, draft.id, 'draft-manifest.json'))).toBe(false);
  });

  it('does not authorize a previously unseen model descendant through a link', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'otto-mcp-new-link-'));
    roots.push(parent);
    const root = join(parent, 'drafts');
    const outside = join(parent, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    const draft = simpleDraft();
    draft.files = [
      { path: 'first.txt', content: 'first' },
      { path: 'nested/payload.txt', content: 'must stay inside' },
    ];
    writeBoundary.afterClose = () => {
      symlinkSync(outside, join(root, draft.id, 'nested'), 'junction');
    };

    await expect(saveMcpCreationDraft(draft, root)).rejects.toThrow(/link/i);
    expect(existsSync(join(outside, 'payload.txt'))).toBe(false);
    expect(existsSync(join(root, draft.id, 'draft-manifest.json'))).toBe(false);
  });

  it('remote probe only initializes and lists tools', async () => {
    const methods: string[] = [];
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      methods.push(body.method);
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id: 1,
          result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'safe', version: '1.0.0' } },
        }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' } });
      }
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: 2,
        result: { tools: [{ name: 'read_only_search' }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const result = await probeRemoteMcpCandidate({
      id: 'safe@1', name: 'safe', description: 'remote', source: 'official_registry',
      version: '1', repositoryUrl: 'https://github.com/example/safe',
      commitSha: 'a'.repeat(40), license: 'MIT', remoteUrl: 'https://mcp.example.com/mcp',
      environmentVariables: [], permissions: ['network'], installed: false, trust: false,
    }, fakeFetch, async () => undefined);

    expect(methods).toEqual(['initialize', 'tools/list']);
    expect(result).toMatchObject({ status: 'passed', tools: ['read_only_search'] });
  });

  it.each([
    'https://0.1.2.3/mcp',
    'https://10.0.0.1/mcp',
    'https://100.64.0.1/mcp',
    'https://127.0.0.1/mcp',
    'https://169.254.169.254/latest/meta-data',
    'https://172.31.255.255/mcp',
    'https://192.168.1.1/mcp',
    'https://198.18.0.1/mcp',
    'https://224.0.0.1/mcp',
    'https://[::1]/mcp',
    'https://[::ffff:127.0.0.1]/mcp',
    'https://[fc00::1]/mcp',
    'https://[fe80::1]/mcp',
  ])('blocks non-public and IPv4-mapped MCP endpoints: %s', async (remoteUrl) => {
    await expect(resolvePublicMcpEndpoint(new URL(remoteUrl))).rejects.toThrow(/blocked|public/i);
  });

  it('rejects a hostname when any DNS answer is private to prevent mixed-answer bypasses', async () => {
    await expect(resolvePublicMcpEndpoint(
      new URL('https://mcp.example.com/mcp'),
      async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    )).rejects.toThrow(/blocked/i);
  });

  it('rejects forged JSON-RPC ids, protocol versions, errors and missing result objects', async () => {
    const invalidPayloads = [
      { jsonrpc: '2.0', id: 99, result: {} },
      { jsonrpc: '1.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 1, error: { code: -32_000, message: 'nope' } },
      { jsonrpc: '2.0', id: 1 },
    ];
    for (const payload of invalidPayloads) {
      const fakeFetch = (async () => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
      await expect(probeRemoteMcpCandidate(
        safeRemoteCandidate(),
        fakeFetch,
        async () => ({ hostname: 'mcp.example.com', addresses: [{ address: '93.184.216.34', family: 4 }] }),
      )).rejects.toThrow(/JSON-RPC|result|error/i);
    }
  });

  it('caps remote probe response bytes and tool-list cardinality', async () => {
    const hugeFetch = (async () => new Response('x'.repeat(1_048_577), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    await expect(probeRemoteMcpCandidate(
      safeRemoteCandidate(),
      hugeFetch,
      async () => ({ hostname: 'mcp.example.com', addresses: [{ address: '93.184.216.34', family: 4 }] }),
    )).rejects.toThrow(/large|size|bytes/i);

    let request = 0;
    const floodFetch = (async () => {
      request += 1;
      return new Response(JSON.stringify(request === 1
        ? { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'safe', version: '1' } } }
        : { jsonrpc: '2.0', id: 2, result: { tools: Array.from({ length: 513 }, (_, i) => ({ name: `tool_${i}` })) } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    await expect(probeRemoteMcpCandidate(
      safeRemoteCandidate(),
      floodFetch,
      async () => ({ hostname: 'mcp.example.com', addresses: [{ address: '93.184.216.34', family: 4 }] }),
    )).rejects.toThrow(/tools|many|limit/i);
  });

  it('caps untrusted Registry catalogue responses before JSON parsing', async () => {
    const fakeFetch = (async () => new Response(' '.repeat(2_097_153), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    await expect(searchOfficialMcpRegistry('calendar', fakeFetch)).rejects.toThrow(/large|size|bytes/i);
  });

  it.each(['../escape.ts', 'nested/../../escape.ts', '/absolute.ts', 'C:\\escape.ts', 'C:escape.ts', '\\rooted.ts', '\\\\host\\share\\escape.ts']) (
    'rejects a malicious generated draft path: %s',
    async (maliciousPath) => {
      const root = mkdtempSync(join(tmpdir(), 'otto-mcp-draft-'));
      roots.push(root);
      const draft = generateTypeScriptMcpDraft({
        name: 'safe-draft', description: 'safe', inputKind: 'natural_language',
        sourceText: 'safe', transport: 'stdio',
      });
      draft.files.push({ path: maliciousPath, content: 'owned' });
      await expect(saveMcpCreationDraft(draft, root)).rejects.toThrow(/path|invalid|escaped/i);
    },
  );

  it('rejects a symlinked draft root instead of writing outside the user draft directory', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'otto-mcp-parent-'));
    const outside = mkdtempSync(join(tmpdir(), 'otto-mcp-outside-'));
    roots.push(parent, outside);
    const linkedRoot = join(parent, 'drafts');
    symlinkSync(outside, linkedRoot, 'junction');
    const draft = generateTypeScriptMcpDraft({
      name: 'safe-draft', description: 'safe', inputKind: 'natural_language',
      sourceText: 'safe', transport: 'stdio',
    });
    await expect(saveMcpCreationDraft(draft, linkedRoot)).rejects.toThrow(/symbolic|link|root/i);
  });

  it('enforces creator resource limits even when called outside WebSocket validation', () => {
    expect(() => generateTypeScriptMcpDraft({
      name: 'orders', description: 'orders', inputKind: 'natural_language',
      sourceText: 'safe', transport: 'stdio',
      environmentVariables: Array.from({ length: 65 }, (_, index) => `TOKEN_${index}`),
    })).toThrow(/environment|many|limit/i);
    expect(() => generateTypeScriptMcpDraft({
      name: 'orders', description: 'orders', inputKind: 'api_docs',
      sourceText: '😀'.repeat(600_000), transport: 'stdio',
    })).toThrow(/source|large|2MB/i);
    expect(() => generateTypeScriptMcpDraft({
      name: 'orders', description: 'orders', inputKind: 'openapi',
      sourceText: JSON.stringify({
        paths: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [
          `/orders/${index}`, { get: { operationId: `getOrder${index}` } },
        ])),
      }),
      transport: 'stdio',
    })).toThrow(/operation|many|limit/i);
  });

  it('preflights duplicate and excessive draft files before creating a partial directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'otto-mcp-draft-'));
    roots.push(root);
    const duplicate = generateTypeScriptMcpDraft({
      name: 'safe', description: 'safe', inputKind: 'natural_language',
      sourceText: 'safe', transport: 'stdio',
    });
    duplicate.files.push({ path: duplicate.files[0]!.path, content: 'duplicate' });
    await expect(saveMcpCreationDraft(duplicate, root)).rejects.toThrow(/duplicate/i);

    const excessive = generateTypeScriptMcpDraft({
      name: 'safe', description: 'safe', inputKind: 'natural_language',
      sourceText: 'safe', transport: 'stdio',
    });
    excessive.files.push(...Array.from({ length: 65 }, (_, index) => ({
      path: `extra/${index}.txt`, content: 'x',
    })));
    await expect(saveMcpCreationDraft(excessive, root)).rejects.toThrow(/many|limit|files/i);
  });
});

function safeRemoteCandidate() {
  return {
    id: 'safe@1', name: 'safe', description: 'remote', source: 'official_registry' as const,
    version: '1', repositoryUrl: 'https://github.com/example/safe',
    commitSha: 'a'.repeat(40), license: 'MIT', remoteUrl: 'https://mcp.example.com/mcp',
    environmentVariables: [], permissions: ['network' as const], installed: false as const, trust: false as const,
  };
}

function simpleDraft() {
  return generateTypeScriptMcpDraft({
    name: 'safe-draft', description: 'safe', inputKind: 'natural_language',
    sourceText: 'safe', transport: 'stdio',
  });
}
