/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { EnterpriseKnowledgeItem } from '../preload/index.js';
import { evaluateEnterpriseKnowledgeApplicability } from './enterpriseKnowledgeApplicability.js';

const NOW = Date.parse('2026-08-28T08:00:00.000Z');

function knowledge(overrides: Partial<EnterpriseKnowledgeItem> = {}): EnterpriseKnowledgeItem {
  return {
    id: 'knowledge-1',
    organizationId: 'org-a',
    sourceId: 'manual-1',
    title: '客户数据导出制度',
    department: null,
    category: 'policy',
    content: '客户数据导出必须审批。',
    contributor: '管理员',
    confidence: 0.98,
    sourceType: 'manual',
    sourceLabel: '管理员发布',
    status: 'active',
    version: 1,
    supersedesId: null,
    reviewedBy: '管理员',
    reviewedAt: '2026-08-20T08:00:00.000Z',
    createdAt: '2026-08-20T08:00:00.000Z',
    updatedAt: '2026-08-20T08:00:00.000Z',
    ...overrides,
  };
}

describe('enterprise knowledge applicability lifecycle', () => {
  it('treats the server hard-expiry as unusable even for manual knowledge', () => {
    expect(evaluateEnterpriseKnowledgeApplicability(knowledge({
      expiresAt: '2026-08-27T08:00:00.000Z',
    }), NOW)).toEqual({
      state: 'historical',
      usable: false,
      reason: '服务器登记的知识有效期已结束',
    });
  });

  it('requires verification after the server review date but before hard expiry', () => {
    expect(evaluateEnterpriseKnowledgeApplicability(knowledge({
      reviewDueAt: '2026-08-27T08:00:00.000Z',
      expiresAt: '2026-09-30T08:00:00.000Z',
    }), NOW)).toEqual({
      state: 'verify_before_use',
      usable: true,
      reason: '已到管理员复核日期',
    });
  });

  it('uses a newer administrator review instead of an older auto-capture observation', () => {
    expect(evaluateEnterpriseKnowledgeApplicability(knowledge({
      sourceType: 'auto_capture',
      lastObservedAt: '2025-01-01T00:00:00.000Z',
      reviewedAt: '2026-08-20T08:00:00.000Z',
      updatedAt: '2026-08-20T08:00:00.000Z',
    }), NOW)).toMatchObject({ state: 'current', usable: true });
  });
});
