/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  createEnterpriseKnowledgeFacade,
  createEnterpriseKnowledgeSchemaContributor,
  ENTERPRISE_KNOWLEDGE_MAX_SOURCE_ID_LENGTH,
  type EnterpriseKnowledgeRepositoryStore,
} from './modules/enterprise_knowledge/index.js';
import {
  applyDatabaseSchemaContributors,
  Database,
} from './modules/data_platform/index.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE organizations (id TEXT PRIMARY KEY);');
  applyDatabaseSchemaContributors(database, [
    createEnterpriseKnowledgeSchemaContributor({ defaultOrganizationId: 'org-a' }),
  ]);
  database.exec("INSERT INTO organizations (id) VALUES ('org-a'), ('org-b');");
  return database;
}

function createStore(database: Database): EnterpriseKnowledgeRepositoryStore {
  return {
    db: () => database,
    defaultOrganizationId: 'org-a',
    organizationExists: (organizationId) =>
      Boolean(
        database
          .prepare('SELECT 1 FROM organizations WHERE id = ?')
          .get(organizationId),
      ),
  };
}

describe('enterprise knowledge kernel', () => {
  it('incubates ordinary conversation evidence and only promotes repeated or high-impact knowledge', () => {
    const database = createDatabase();
    const knowledge = createEnterpriseKnowledgeFacade(createStore(database));

    try {
      const ordinary = {
        organizationId: 'org-a',
        department: '客服部',
        category: 'convention',
        content: '客户验收前需要先核对交付清单。',
        tags: ['acceptance'],
        contributor: '张三',
        contributorAccountId: 'account-1',
        sourceId: 'capture-1',
        sourceSessionId: 'session-1',
        sourceFingerprint: 'acceptance-checklist',
        confidence: 0.82,
        verified: false,
      };
      expect(knowledge.observeKnowledge(ordinary)).toMatchObject({
        outcome: 'observed',
        promoted: false,
        reason: 'incubating',
        evidenceCount: 1,
      });
      expect(knowledge.observeKnowledge(ordinary)).toMatchObject({
        outcome: 'duplicate',
        promoted: false,
        evidenceCount: 1,
      });
      expect(knowledge.getKnowledgeForAdministration('', undefined, 'org-a')).toEqual([]);

      expect(knowledge.observeKnowledge({
        ...ordinary,
        contributor: '李四',
        contributorAccountId: 'account-2',
        sourceId: 'capture-2',
        sourceSessionId: 'session-2',
        confidence: 0.9,
      })).toMatchObject({ promoted: false, evidenceCount: 2 });
      const promoted = knowledge.observeKnowledge({
        ...ordinary,
        sourceId: 'capture-3',
        sourceSessionId: 'session-3',
      });
      expect(promoted).toMatchObject({
        outcome: 'promoted',
        promoted: true,
        reason: 'cross_member_corroboration',
        evidenceCount: 3,
        distinctSessionCount: 3,
        distinctContributorCount: 2,
        knowledge: expect.objectContaining({
          status: 'pending_review',
          contributor: '李四',
          contributor_account_id: 'account-2',
        }),
      });
      expect(promoted.knowledge?.content).toContain('## 长期结论');
      expect(promoted.knowledge?.content).toContain('## 形成依据');
      expect(promoted.knowledge?.content).toContain('3 条独立证据');
      expect(promoted.reliabilityScore).toBeGreaterThanOrEqual(0.7);
      expect(promoted.knowledge!.confidence).toBe(promoted.reliabilityScore);
      expect(promoted.knowledge!.confidence).toBeLessThan(ordinary.confidence);

      const deep = knowledge.observeKnowledge({
        organizationId: 'org-a',
        department: '研发部',
        category: 'solution',
        content: '重大生产事故的根因是租户缓存未隔离，加入企业编号后验证通过。',
        contributor: '王工',
        contributorAccountId: 'account-3',
        sourceId: 'incident-1',
        sourceSessionId: 'incident-session-1',
        confidence: 0.93,
        verified: true,
      });
      expect(deep).toMatchObject({
        outcome: 'observed',
        promoted: false,
        reason: 'incubating',
        evidenceCount: 1,
      });
      const corroboratedDeep = knowledge.observeKnowledge({
        organizationId: 'org-a',
        department: '研发部',
        category: 'solution',
        content: '隔离复测确认：生产事故源于租户缓存键未包含企业编号，修复后验证通过。',
        contributor: '李工',
        contributorAccountId: 'account-4',
        sourceId: 'incident-2',
        sourceSessionId: 'incident-session-2',
        confidence: 0.91,
        verified: true,
      });
      expect(corroboratedDeep).toMatchObject({
        outcome: 'promoted',
        reason: 'high_impact_verified',
        evidenceCount: 2,
        verifiedEvidenceCount: 2,
        knowledge: expect.objectContaining({ status: 'pending_review' }),
      });
      expect(corroboratedDeep.reliabilityScore).toBeGreaterThanOrEqual(0.78);
      expect(corroboratedDeep.knowledge!.confidence).toBe(corroboratedDeep.reliabilityScore);
      const refinedDeep = knowledge.observeKnowledge({
        organizationId: 'org-a',
        department: '研发部',
        category: 'solution',
        content: '生产隔离回归测试再次通过：缓存键必须包含企业编号，避免租户数据串读。',
        contributor: '王工',
        contributorAccountId: 'account-3',
        sourceId: 'incident-3',
        sourceSessionId: 'incident-session-3',
        confidence: 0.9,
        verified: true,
      });
      expect(refinedDeep).toMatchObject({
        promoted: true,
        evidenceCount: 3,
        knowledge: expect.objectContaining({
          status: 'pending_review',
          version: 2,
        }),
      });
      expect(refinedDeep.knowledge?.content).toContain('3 条独立证据');
      expect(JSON.stringify(knowledge.getKnowledgeForAdministration('', undefined, 'org-b')))
        .not.toContain('租户缓存');
    } finally {
      database.close();
    }
  });

  it('uses observed time for long-term recurrence and blocks contradictory evidence', () => {
    const database = createDatabase();
    const knowledge = createEnterpriseKnowledgeFacade(createStore(database));

    try {
      const base = {
        organizationId: 'org-a',
        department: '交付部',
        category: 'convention',
        tags: ['acceptance'],
        contributor: '张三',
        contributorAccountId: 'account-1',
        confidence: 0.9,
        verified: true,
      };
      knowledge.observeKnowledge({
        ...base,
        content: '客户验收前必须完成安全扫描。',
        sourceId: 'policy-observation-1',
        sourceSessionId: 'policy-session-1',
        observedAt: '2026-07-01T00:00:00.000Z',
      });
      knowledge.observeKnowledge({
        ...base,
        contributor: '李四',
        contributorAccountId: 'account-2',
        content: '客户验收前无需完成安全扫描。',
        sourceId: 'policy-observation-2',
        sourceSessionId: 'policy-session-2',
        observedAt: '2026-07-10T00:00:00.000Z',
      });
      const contested = knowledge.observeKnowledge({
        ...base,
        content: '客户验收前必须先完成安全扫描。',
        sourceId: 'policy-observation-3',
        sourceSessionId: 'policy-session-3',
        observedAt: '2026-07-20T00:00:00.000Z',
      });
      expect(contested).toMatchObject({
        promoted: false,
        reason: 'contested',
        evidenceCount: 3,
        spanDays: 19,
        contradictoryEvidenceCount: 3,
      });
      expect(knowledge.getKnowledgeForAdministration('', undefined, 'org-a')).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('requires an explicit administrator resolution before publishing a contested candidate', () => {
    const database = createDatabase();
    const knowledge = createEnterpriseKnowledgeFacade(createStore(database));

    try {
      const base = {
        organizationId: 'org-a',
        department: '安全部',
        category: 'convention',
        confidence: 0.92,
        verified: true,
      };
      knowledge.observeKnowledge({
        ...base,
        content: '生产环境必须启用双因素认证并完成安全验证。',
        contributor: '张三',
        contributorAccountId: 'account-1',
        sourceId: 'mfa-1',
        sourceSessionId: 'mfa-session-1',
      });
      const promoted = knowledge.observeKnowledge({
        ...base,
        content: '安全制度要求生产环境必须启用双因素认证，验证通过。',
        contributor: '李四',
        contributorAccountId: 'account-2',
        sourceId: 'mfa-2',
        sourceSessionId: 'mfa-session-2',
      });
      expect(promoted).toMatchObject({ promoted: true });

      const contested = knowledge.observeKnowledge({
        ...base,
        content: '生产环境禁止启用双因素认证。',
        contributor: '王五',
        contributorAccountId: 'account-3',
        sourceId: 'mfa-3',
        sourceSessionId: 'mfa-session-3',
      });
      expect(contested).toMatchObject({ reason: 'contested' });
      expect(contested.knowledge?.source_label).toContain('证据存在冲突');
      expect(() => knowledge.reviewKnowledge({
        id: promoted.knowledge!.id,
        organizationId: 'org-a',
        action: 'approve',
        reviewer: '管理员',
      })).toThrow('contested knowledge must be resolved before approval');

      const resolved = knowledge.reviseKnowledge({
        id: promoted.knowledge!.id,
        organizationId: 'org-a',
        title: '生产环境双因素认证规则',
        content: '生产环境必须启用双因素认证；例外情况由安全负责人书面批准。',
        changedBy: '管理员',
        changeNote: '核对安全制度后裁决冲突',
        resolveConflict: true,
      });
      expect(resolved?.source_label).toContain('管理员已裁决冲突');
      expect(() => knowledge.reviewKnowledge({
        id: promoted.knowledge!.id,
        organizationId: 'org-a',
        action: 'approve',
        reviewer: '管理员',
      })).not.toThrow();
    } finally {
      database.close();
    }
  });

  it('isolates source-id deduplication by organization and rejects missing tenants', () => {
    const database = createDatabase();
    const knowledge = createEnterpriseKnowledgeFacade(createStore(database));

    try {
      const entry = {
        sourceId: 'shared-source',
        category: 'process',
        content: 'Shared process knowledge',
      };
      expect(
        knowledge.addKnowledge({ ...entry, organizationId: 'org-a' }),
      ).toBe(true);
      expect(
        knowledge.addKnowledge({ ...entry, organizationId: 'org-a' }),
      ).toBe(false);
      expect(
        knowledge.addKnowledge({ ...entry, organizationId: 'org-b' }),
      ).toBe(true);
      expect(
        knowledge.getKnowledge(undefined, undefined, 'org-a'),
      ).toHaveLength(1);
      expect(
        knowledge.getKnowledge(undefined, undefined, 'org-b'),
      ).toHaveLength(1);
      expect(() =>
        knowledge.addKnowledge({ ...entry, organizationId: 'missing' }),
      ).toThrow('Organization not found');
      expect(() =>
        knowledge.getKnowledge(undefined, undefined, 'missing'),
      ).toThrow('Organization not found');
    } finally {
      database.close();
    }
  });

  it('limits members to global knowledge and their own department', () => {
    const database = createDatabase();
    const knowledge = createEnterpriseKnowledgeFacade(createStore(database));

    try {
      knowledge.addKnowledge({
        organizationId: 'org-a',
        category: 'global',
        content: 'All employees can read this',
      });
      knowledge.addKnowledge({
        organizationId: 'org-a',
        department: '研发部',
        category: 'engineering',
        content: '研发内部方案',
      });
      knowledge.addKnowledge({
        organizationId: 'org-a',
        department: '销售部',
        category: 'sales',
        content: '销售客户名单',
      });
      knowledge.addKnowledge({
        organizationId: 'org-b',
        category: 'other-tenant',
        content: 'Other tenant secret',
      });

      expect(
        knowledge
          .getMemberKnowledge('研发部', '', 'org-a')
          .map((entry) => entry.category),
      ).toEqual(expect.arrayContaining(['global', 'engineering']));
      expect(
        knowledge
          .getMemberKnowledge('研发部', '', 'org-a')
          .map((entry) => entry.category),
      ).not.toContain('sales');
      expect(
        knowledge
          .getMemberKnowledge(null, '', 'org-a')
          .map((entry) => entry.category),
      ).toEqual(['global']);
      expect(
        JSON.stringify(knowledge.getMemberKnowledge('研发部', '', 'org-a')),
      ).not.toContain('Other tenant secret');
    } finally {
      database.close();
    }
  });

  it('searches percent and underscore as literal characters', () => {
    const database = createDatabase();
    const knowledge = createEnterpriseKnowledgeFacade(createStore(database));

    try {
      knowledge.addKnowledge({
        category: 'metrics',
        content: 'Coverage is 100%',
      });
      knowledge.addKnowledge({
        category: 'metrics',
        content: 'Coverage is 100X',
      });
      knowledge.addKnowledge({
        category: 'under_score',
        content: 'Literal marker',
      });
      knowledge.addKnowledge({
        category: 'underXscore',
        content: 'Wildcard decoy',
      });

      expect(
        knowledge.searchKnowledge('%').map((entry) => entry.content),
      ).toEqual(['Coverage is 100%']);
      expect(
        knowledge.searchKnowledge('_').map((entry) => entry.category),
      ).toEqual(['under_score']);
    } finally {
      database.close();
    }
  });

  it('normalizes stored fields and rejects invalid content boundaries', () => {
    const database = createDatabase();
    const knowledge = createEnterpriseKnowledgeFacade(createStore(database));

    try {
      expect(
        knowledge.addKnowledge({
          department: ' 研发部 ',
          category: ' solution ',
          content: ' 可复用方案 ',
          contributor: ' 张三 ',
          sourceId: ' source-1 ',
          confidence: 0.9,
        }),
      ).toBe(true);
      expect(knowledge.getKnowledge('研发部', 'solution')).toEqual([
        expect.objectContaining({
          department: '研发部',
          category: 'solution',
          content: '可复用方案',
          contributor: '张三',
          source_id: 'source-1',
          confidence: 0.9,
        }),
      ]);
      expect(() =>
        knowledge.addKnowledge({ category: ' ', content: 'content' }),
      ).toThrow('knowledge category is required');
      expect(() =>
        knowledge.addKnowledge({ category: 'general', content: ' ' }),
      ).toThrow('knowledge content is required');
      expect(() =>
        knowledge.addKnowledge({
          category: 'general',
          content: 'content',
          confidence: 2,
        }),
      ).toThrow('knowledge confidence must be between 0 and 1');
      expect(() =>
        knowledge.addKnowledge({
          category: 'general',
          content: 'content',
          sourceId: 'x'.repeat(ENTERPRISE_KNOWLEDGE_MAX_SOURCE_ID_LENGTH + 1),
        }),
      ).toThrow('knowledge source id is too long');
    } finally {
      database.close();
    }
  });

  it('keeps member submissions out of retrieval until approval and preserves revisions', () => {
    const database = createDatabase();
    const knowledge = createEnterpriseKnowledgeFacade(createStore(database));

    try {
      const saved = knowledge.saveKnowledge({
        organizationId: 'org-a',
        sourceId: 'work-result-1',
        title: '客户验收流程',
        category: 'process',
        content: '提交验收单后由项目负责人复核。',
        contributor: '张三',
        contributorAccountId: 'account-1',
        status: 'pending_review',
        sourceType: 'work_result',
      });
      expect(saved.entry.status).toBe('pending_review');
      expect(knowledge.searchKnowledge('验收', undefined, 'org-a')).toEqual([]);
      expect(knowledge.getMemberKnowledge('研发部', '验收', 'org-a')).toEqual([]);
      expect(
        knowledge.getMemberKnowledge('研发部', '验收', 'org-a', {
          includeOwnPending: true,
          contributorAccountId: 'account-1',
        }),
      ).toEqual([expect.objectContaining({ id: saved.entry.id })]);

      const approved = knowledge.reviewKnowledge({
        id: saved.entry.id,
        organizationId: 'org-a',
        action: 'approve',
        reviewer: '管理员',
      });
      expect(approved).toEqual(expect.objectContaining({ status: 'active', version: 2 }));
      expect(knowledge.searchKnowledge('验收', undefined, 'org-a')).toHaveLength(1);

      const revised = knowledge.reviseKnowledge({
        id: saved.entry.id,
        organizationId: 'org-a',
        content: '提交验收单后由项目负责人和客户共同复核。',
        changedBy: '管理员',
        changeNote: '补充客户确认环节',
      });
      expect(revised).toEqual(expect.objectContaining({ version: 3 }));
      expect(knowledge.getKnowledgeRevisions(saved.entry.id, 'org-a'))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ version: 1, status: 'pending_review' }),
          expect.objectContaining({ version: 2, status: 'active' }),
          expect.objectContaining({ version: 3, change_note: '补充客户确认环节' }),
        ]));

      knowledge.reviewKnowledge({
        id: saved.entry.id,
        organizationId: 'org-a',
        action: 'archive',
        reviewer: '管理员',
      });
      expect(knowledge.searchKnowledge('验收', undefined, 'org-a')).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('promotes the selected successor safely when several revisions await review', () => {
    const database = createDatabase();
    const knowledge = createEnterpriseKnowledgeFacade(createStore(database));

    try {
      const original = knowledge.saveKnowledge({
        organizationId: 'org-a',
        sourceId: 'policy-1',
        category: 'policy',
        content: '报销上限为 1000 元。',
        status: 'active',
      }).entry;
      const firstRevision = knowledge.saveKnowledge({
        organizationId: 'org-a',
        sourceId: 'policy-1',
        category: 'policy',
        content: '报销上限为 1500 元。',
        status: 'pending_review',
      }).entry;
      const secondRevision = knowledge.saveKnowledge({
        organizationId: 'org-a',
        sourceId: 'policy-1',
        category: 'policy',
        content: '报销上限为 2000 元。',
        status: 'pending_review',
      }).entry;

      knowledge.reviewKnowledge({
        id: firstRevision.id,
        organizationId: 'org-a',
        action: 'approve',
        reviewer: '管理员',
      });
      expect(knowledge.getKnowledge(undefined, 'policy', 'org-a'))
        .toEqual([expect.objectContaining({ id: firstRevision.id })]);

      expect(() => knowledge.reviewKnowledge({
        id: secondRevision.id,
        organizationId: 'org-a',
        action: 'approve',
        reviewer: '管理员',
      })).not.toThrow();
      expect(knowledge.getKnowledge(undefined, 'policy', 'org-a'))
        .toEqual([expect.objectContaining({ id: secondRevision.id })]);
      expect(knowledge.getKnowledgeForAdministration('', undefined, 'org-a', 'archived'))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ id: original.id }),
          expect.objectContaining({ id: firstRevision.id }),
        ]));
    } finally {
      database.close();
    }
  });

  it('exports every lifecycle record instead of truncating backups to the admin view limit', () => {
    const database = createDatabase();
    const knowledge = createEnterpriseKnowledgeFacade(createStore(database));

    try {
      for (let index = 0; index < 125; index += 1) {
        knowledge.saveKnowledge({
          organizationId: 'org-a',
          sourceId: `backup-${index}`,
          category: 'backup',
          content: `知识记录 ${index}`,
          status: index % 2 === 0 ? 'active' : 'pending_review',
        });
      }
      expect(knowledge.getKnowledgeForAdministration('', undefined, 'org-a')).toHaveLength(100);
      expect(knowledge.getKnowledgeForBackup('org-a')).toHaveLength(125);
    } finally {
      database.close();
    }
  });
});
