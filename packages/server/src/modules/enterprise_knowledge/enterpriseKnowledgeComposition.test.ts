/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { createEnterpriseKnowledgeComposition } from './enterpriseKnowledgeComposition.js';
import { createEnterpriseKnowledgeSchemaContributor } from './enterpriseKnowledgeSchema.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE organizations (id TEXT PRIMARY KEY);');
  applyDatabaseSchemaContributors(database, [
    createEnterpriseKnowledgeSchemaContributor({
      defaultOrganizationId: 'org-a',
    }),
  ]);
  database.exec("INSERT INTO organizations (id) VALUES ('org-a'), ('org-b');");
  return database;
}

function createComposition(database: Database) {
  const organizations = new Set(['org-a', 'org-b']);
  return createEnterpriseKnowledgeComposition({
    db: () => database,
    defaultOrganizationId: 'org-a',
    getOrganization: (organizationId) =>
      organizations.has(organizationId) ? { id: organizationId } : null,
  });
}

describe('enterprise knowledge composition', () => {
  it('uses the default tenant and keeps source idempotency tenant-scoped', () => {
    const database = createDatabase();
    const knowledge = createComposition(database);
    const entry = {
      sourceId: 'shared-source',
      category: 'process',
      content: 'Reusable process',
    };

    try {
      expect(knowledge.addKnowledge(entry)).toBe(true);
      expect(knowledge.addKnowledge(entry)).toBe(false);
      expect(
        knowledge.addKnowledge({ ...entry, organizationId: 'org-b' }),
      ).toBe(true);
      expect(knowledge.getKnowledge()).toHaveLength(1);
      expect(
        knowledge.getKnowledge(undefined, undefined, 'org-b'),
      ).toHaveLength(1);
      expect(() =>
        knowledge.addKnowledge({ ...entry, organizationId: 'missing' }),
      ).toThrow('Organization not found');
    } finally {
      database.close();
    }
  });

  it('limits members to global and same-department knowledge', () => {
    const database = createDatabase();
    const knowledge = createComposition(database);

    try {
      knowledge.addKnowledge({
        category: 'global',
        content: 'Visible to everyone',
      });
      knowledge.addKnowledge({
        department: 'Engineering',
        category: 'engineering',
        content: 'Engineering only',
      });
      knowledge.addKnowledge({
        department: 'Sales',
        category: 'sales',
        content: 'Sales only',
      });

      expect(
        knowledge
          .getMemberKnowledge('Engineering')
          .map((entry) => entry.category),
      ).toEqual(expect.arrayContaining(['global', 'engineering']));
      expect(
        knowledge
          .getMemberKnowledge('Engineering')
          .map((entry) => entry.category),
      ).not.toContain('sales');
      expect(
        knowledge.getMemberKnowledge(null).map((entry) => entry.category),
      ).toEqual(['global']);
    } finally {
      database.close();
    }
  });

  it('returns evidence strength with promoted enterprise knowledge', () => {
    const database = createDatabase();
    const knowledge = createComposition(database);

    try {
      const first = knowledge.observeKnowledge({
        organizationId: 'org-a',
        category: 'solution',
        content: '重大生产事故的根因是租户缓存未隔离，加入企业编号后验证通过。',
        contributor: '研发成员',
        contributorAccountId: 'account-a',
        sourceId: 'session-a:solution',
        sourceSessionId: 'session-a',
        confidence: 0.95,
        verified: true,
      });
      expect(first.promoted).toBe(false);
      const observed = knowledge.observeKnowledge({
        organizationId: 'org-a',
        category: 'solution',
        content: '复测确认重大生产事故源于租户缓存未隔离，加入企业编号后验证通过。',
        contributor: '另一名研发成员',
        contributorAccountId: 'account-b',
        sourceId: 'session-b:solution',
        sourceSessionId: 'session-b',
        confidence: 0.93,
        verified: true,
      });
      expect(observed.promoted).toBe(true);
      knowledge.reviewKnowledge({
        id: observed.knowledge!.id,
        organizationId: 'org-a',
        action: 'approve',
        reviewer: '企业管理员',
      });

      expect(knowledge.getKnowledge()[0]).toMatchObject({
        evidence_count: 2,
        distinct_session_count: 2,
        distinct_contributor_count: 2,
        verified_evidence_count: 2,
      });
    } finally {
      database.close();
    }
  });

  it('permanently deletes only the selected tenant memory and its supporting evidence', () => {
    const database = createDatabase();
    const knowledge = createComposition(database);

    try {
      const first = knowledge.observeKnowledge({
        organizationId: 'org-a', category: 'solution',
        content: '重大故障根因是缓存键缺少企业编号，修复后测试通过。',
        contributor: '成员甲', contributorAccountId: 'account-a',
        sourceId: 'delete-a-1', sourceSessionId: 'delete-session-a-1',
        confidence: 0.95, verified: true,
      });
      expect(first.promoted).toBe(false);
      const promoted = knowledge.observeKnowledge({
        organizationId: 'org-a', category: 'solution',
        content: '复测确认重大故障来自缓存键缺少企业编号，补齐后验证通过。',
        contributor: '成员乙', contributorAccountId: 'account-b',
        sourceId: 'delete-a-2', sourceSessionId: 'delete-session-a-2',
        confidence: 0.94, verified: true,
      }).knowledge!;
      const otherTenant = knowledge.saveKnowledge({
        organizationId: 'org-b', sourceId: 'keep-b', category: 'process',
        content: '另一个企业的知识必须保留。',
      }).entry;

      expect(knowledge.deleteKnowledge({ id: promoted.id, organizationId: 'org-a' })).toBe(true);
      expect(knowledge.deleteKnowledge({ id: promoted.id, organizationId: 'org-a' })).toBe(false);
      expect(knowledge.getKnowledgeForAdministration('', undefined, 'org-a')).toEqual([]);
      expect(database.prepare(
        'SELECT COUNT(*) AS count FROM knowledge_retention_evidence WHERE organization_id = ?',
      ).get('org-a')).toEqual({ count: 0 });
      expect(knowledge.getKnowledge(undefined, undefined, 'org-b')[0]?.id).toBe(otherTenant.id);
    } finally {
      database.close();
    }
  });
});
