/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Database } from '../data_platform/index.js';
import { MCP_TOOL_CATALOG_SCHEMA_CONTRIBUTOR } from './mcpToolCatalogSchema.js';
import {
  createSqliteMcpToolCatalogRepository,
  type EnterpriseMcpCatalogActor,
} from './mcpToolCatalogRepository.js';

function actor(
  organizationId: string,
  accountId: string,
  isAdmin = false,
): EnterpriseMcpCatalogActor {
  return { organizationId, accountId, isAdmin };
}

function createRepository() {
  const database = new Database(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO organizations (id, name) VALUES
      ('org-a', '甲企业'), ('org-b', '乙企业');
  `);
  MCP_TOOL_CATALOG_SCHEMA_CONTRIBUTOR.apply(database);
  return {
    database,
    repository: createSqliteMcpToolCatalogRepository({
      db: () => database,
      organizationExists: (organizationId) =>
        organizationId === 'org-a' || organizationId === 'org-b',
    }),
  };
}

const crmServer = {
  serverKey: 'crm-main',
  displayName: '客户关系系统',
  description: '企业 CRM 的受控只读能力。',
  transport: 'streamable_http' as const,
  connectionRef: 'connector://crm/production',
  tools: [
    {
      name: 'crm.search_customer',
      displayName: '查询客户',
      description: '按客户名称或编号查询。',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  ],
};

describe('enterprise MCP tool catalog repository', () => {
  it('registers one authoritative tenant catalog without exposing connection details to members', () => {
    const { database, repository } = createRepository();
    try {
      const admin = actor('org-a', 'admin-a', true);
      const member = actor('org-a', 'member-a');
      const otherTenant = actor('org-b', 'member-b');

      const registered = repository.replaceServer(admin, crmServer);
      expect(registered.version).toBe(1);
      expect(registered.servers[0]).toMatchObject({
        serverKey: 'crm-main',
        connectionRef: 'connector://crm/production',
        status: 'active',
      });

      const catalog = repository.listCatalog(member);
      expect(catalog.version).toBe(1);
      expect(catalog.servers[0]).not.toHaveProperty('connectionRef');
      expect(catalog.servers[0]?.tools).toEqual([
        expect.objectContaining({ name: 'crm.search_customer' }),
      ]);
      expect(JSON.stringify(catalog)).not.toMatch(/connector:\/\/|token|secret|headers|env/iu);
      expect(repository.listCatalog(otherTenant)).toEqual({
        version: 0,
        updatedAt: null,
        servers: [],
      });

      const disabled = repository.setServerStatus(admin, 'crm-main', 'disabled');
      expect(disabled.version).toBe(2);
      expect(repository.listCatalog(member).servers).toEqual([]);
      expect(repository.listAdminCatalog(admin).servers[0]?.status).toBe('disabled');
    } finally {
      database.close();
    }
  });

  it('atomically replaces tool declarations and rejects canonical-name collisions', () => {
    const { database, repository } = createRepository();
    try {
      const admin = actor('org-a', 'admin-a', true);
      repository.replaceServer(admin, crmServer);
      const replaced = repository.replaceServer(admin, {
        ...crmServer,
        tools: [
          {
            name: 'crm.get_customer',
            displayName: '读取客户',
            description: '读取一个客户。',
            inputSchema: { type: 'object' },
          },
        ],
      });
      expect(replaced.version).toBe(2);
      expect(replaced.servers[0]?.tools.map((tool) => tool.name)).toEqual([
        'crm.get_customer',
      ]);

      expect(() => repository.replaceServer(admin, {
        serverKey: 'crm-shadow',
        displayName: '冲突连接器',
        description: '',
        transport: 'sse',
        connectionRef: 'connector://crm/shadow',
        tools: [
          {
            name: 'crm.get_customer',
            displayName: '冲突工具',
            description: '',
            inputSchema: { type: 'object' },
          },
        ],
      })).toThrow('工具标识已由其他 MCP Server 使用');

      expect(repository.listAdminCatalog(admin)).toMatchObject({
        version: 2,
        servers: [{ serverKey: 'crm-main' }],
      });
    } finally {
      database.close();
    }
  });

  it('fails closed for non-admin writes and unsafe or oversized declarations', () => {
    const { database, repository } = createRepository();
    try {
      const member = actor('org-a', 'member-a');
      const admin = actor('org-a', 'admin-a', true);
      expect(() => repository.replaceServer(member, crmServer)).toThrow('只有企业管理员');
      expect(() => repository.listAdminCatalog(member)).toThrow('只有企业管理员');
      expect(() => repository.replaceServer(admin, {
        ...crmServer,
        connectionRef: 'https://user:password@example.com/mcp?token=secret',
      })).toThrow('连接引用不能包含凭据、查询参数或片段');
      expect(() => repository.replaceServer(admin, {
        ...crmServer,
        tools: [{
          ...crmServer.tools[0]!,
          name: 'CRM.SearchCustomer',
        }],
      })).toThrow('工具标识格式不正确');
      expect(() => repository.replaceServer(admin, {
        ...crmServer,
        tools: Array.from({ length: 101 }, (_, index) => ({
          name: `crm.tool_${index}`,
          displayName: `工具 ${index}`,
          description: '',
          inputSchema: { type: 'object' },
        })),
      })).toThrow('每个 MCP Server 最多登记 100 个工具');
    } finally {
      database.close();
    }
  });
});
