/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auditMcpCandidate,
  generateTypeScriptMcpDraft,
  normalizeGitHubSearchResponse,
  normalizeRegistryResponse,
  probeRemoteMcpCandidate,
  saveMcpCreationDraft,
} from './mcpManagement.js';

const roots: string[] = [];
afterEach(() => {
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
});
