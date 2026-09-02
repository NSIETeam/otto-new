/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { OttoServer } from './server.js';
import type { McpCreationDraft, McpSearchCandidate } from './mcpManagement.js';
import type { ServerToClient } from './protocol.js';

interface FakeConn {
  id: string;
  socket: WebSocket;
  subscriptions: Map<string, never>;
}

interface McpServerInternals {
  mcpSearchCandidates: Map<string, {
    ownerId: string;
    createdAt: number;
    candidate: McpSearchCandidate;
  }>;
  mcpCreationDrafts: Map<string, {
    ownerId: string;
    createdAt: number;
    draft: McpCreationDraft;
  }>;
  handleMcpCandidateAudit(conn: FakeConn, msg: unknown): void;
  handleMcpCreatorPreview(conn: FakeConn, msg: unknown): void;
  handleMcpCreatorSaveDraft(conn: FakeConn, msg: unknown): Promise<void>;
  handleMcpAdd(conn: FakeConn, msg: unknown): void;
  limitMcpStateForOwner<T extends { ownerId: string; createdAt: number }>(
    map: Map<string, T>, ownerId: string, maximum: number,
  ): void;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'otto-mcp-server-security-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('OTTO_USER_DIR', join(root, 'user'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function connection(id: string): { conn: FakeConn; frames: ServerToClient[] } {
  const frames: ServerToClient[] = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    send(value: string) { frames.push(JSON.parse(value) as ServerToClient); },
  } as unknown as WebSocket;
  return { conn: { id, socket, subscriptions: new Map() }, frames };
}

function candidate(): McpSearchCandidate {
  return {
    id: 'io.example/safe@1.0.0',
    name: 'safe',
    description: 'Read-only remote server',
    source: 'official_registry',
    version: '1.0.0',
    repositoryUrl: 'https://github.com/example/safe',
    commitSha: 'a'.repeat(40),
    license: 'MIT',
    remoteUrl: 'https://mcp.example.com/mcp',
    environmentVariables: [],
    permissions: ['network'],
    installed: false,
    trust: false,
  };
}

describe('MCP server-side confirmation and connection isolation', () => {
  it('does not let a second connection audit a candidate owned by the first connection', () => {
    const server = new OttoServer({ port: 0, mock: true });
    const internals = server as unknown as McpServerInternals;
    const first = connection('client-one');
    const second = connection('client-two');
    const item = candidate();
    internals.mcpSearchCandidates.set(JSON.stringify([first.conn.id, item.id]), {
      ownerId: first.conn.id,
      createdAt: Date.now(),
      candidate: item,
    });

    internals.handleMcpCandidateAudit(second.conn, {
      type: 'mcp_candidate_audit', payload: { candidateId: item.id },
    });
    expect(second.frames).toEqual([
      expect.objectContaining({ type: 'error', payload: expect.objectContaining({ code: 'mcp_candidate_audit_failed' }) }),
    ]);

    internals.handleMcpCandidateAudit(first.conn, {
      type: 'mcp_candidate_audit', payload: { candidateId: item.id },
    });
    expect(first.frames).toEqual([
      expect.objectContaining({ type: 'mcp_audit_result' }),
    ]);
  });

  it('expires stale candidate state even for the owning connection', () => {
    const server = new OttoServer({ port: 0, mock: true });
    const internals = server as unknown as McpServerInternals;
    const first = connection('client-one');
    const item = candidate();
    internals.mcpSearchCandidates.set(JSON.stringify([first.conn.id, item.id]), {
      ownerId: first.conn.id,
      createdAt: Date.now() - 16 * 60 * 1000,
      candidate: item,
    });

    internals.handleMcpCandidateAudit(first.conn, {
      type: 'mcp_candidate_audit', payload: { candidateId: item.id },
    });
    expect(first.frames[0]).toMatchObject({
      type: 'error', payload: { code: 'mcp_candidate_audit_failed' },
    });
  });

  it('does not let another connection save a generated draft', async () => {
    const server = new OttoServer({ port: 0, mock: true });
    const internals = server as unknown as McpServerInternals;
    const first = connection('client-one');
    const second = connection('client-two');
    internals.handleMcpCreatorPreview(first.conn, {
      type: 'mcp_creator_preview',
      payload: {
        name: 'orders', description: 'Read orders', inputKind: 'natural_language',
        sourceText: 'create a read-only orders MCP', transport: 'stdio',
      },
    });
    const draftFrame = first.frames.find((frame) => frame.type === 'mcp_creation_draft');
    if (!draftFrame || draftFrame.type !== 'mcp_creation_draft') throw new Error('draft not generated');

    await internals.handleMcpCreatorSaveDraft(second.conn, {
      type: 'mcp_creator_save_draft',
      payload: { draftId: draftFrame.payload.id, confirmed: true },
    });
    expect(second.frames[0]).toMatchObject({
      type: 'error', payload: { code: 'mcp_creator_save_failed' },
    });
  });

  it('keeps the legacy direct-add handler disabled even if protocol validation is bypassed', () => {
    const server = new OttoServer({ port: 0, mock: true });
    const internals = server as unknown as McpServerInternals;
    const attacker = connection('client-attacker');
    internals.handleMcpAdd(attacker.conn, {
      type: 'mcp_add',
      payload: { name: 'bypass', command: 'powershell', args: ['-Command', 'calc'] },
    });
    expect(attacker.frames[0]).toMatchObject({
      type: 'error', payload: { code: 'mcp_add_disabled' },
    });
  });

  it('limits one connection without evicting another connection state', () => {
    const server = new OttoServer({ port: 0, mock: true });
    const internals = server as unknown as McpServerInternals;
    const states = new Map<string, { ownerId: string; createdAt: number }>([
      ['other', { ownerId: 'client-two', createdAt: 1 }],
      ...Array.from({ length: 10 }, (_, index) => [
        `first-${index}`, { ownerId: 'client-one', createdAt: index + 2 },
      ] as const),
    ]);

    internals.limitMcpStateForOwner(states, 'client-one', 8);

    expect(states.has('other')).toBe(true);
    expect([...states.values()].filter((state) => state.ownerId === 'client-one')).toHaveLength(8);
  });
});
