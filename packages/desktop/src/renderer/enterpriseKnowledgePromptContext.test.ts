/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildEnterpriseKnowledgePromptContext,
  enterpriseKnowledgeLookupNotice,
  lookupEnterpriseKnowledgeContext,
} from './enterpriseKnowledgePromptContext.js';

describe('bounded optional enterprise knowledge lookup', () => {
  afterEach(() => vi.useRealTimers());

  it('skips an empty query without allocating work or a timer', async () => {
    vi.useFakeTimers();
    const list = vi.fn();
    expect(await lookupEnterpriseKnowledgeContext('  ', list)).toEqual({ status: 'skipped', context: '' });
    expect(list).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows a normal two-second reply and clears the deadline', async () => {
    vi.useFakeTimers();
    const list = vi.fn(() => new Promise<[]>(resolve => window.setTimeout(() => resolve([]), 2_000)));
    const lookup = lookupEnterpriseKnowledgeContext('  查询  ', list);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await lookup).toEqual({ status: 'ready', context: '' });
    expect(list).toHaveBeenCalledWith({ query: '查询' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a local deadline rather than an outage and ignores late data', async () => {
    vi.useFakeTimers();
    let finish!: (items: []) => void;
    const lookup = lookupEnterpriseKnowledgeContext('制度', () => new Promise(resolve => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await lookup;
    expect(result).toEqual({ status: 'timeout', context: '' });
    expect(enterpriseKnowledgeLookupNotice(result.status)).toContain('不代表服务器已停止服务');
    finish([]);
    await Promise.resolve();
    expect(result.status).toBe('timeout');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('observes late rejection after a deadline without leaking another warning', async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const lookup = lookupEnterpriseKnowledgeContext('制度', () => new Promise((_, fail) => { reject = fail; }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await lookup).status).toBe('timeout');
    reject(new Error('private server details'));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])('clears the timer for a synchronous or asynchronous failure (%s)', async (sync) => {
    vi.useFakeTimers();
    const result = await lookupEnterpriseKnowledgeContext('制度', () => {
      if (sync) throw new Error('secret');
      return Promise.reject(new Error('secret'));
    });
    expect(result).toEqual({ status: 'failed', context: '' });
    expect(enterpriseKnowledgeLookupNotice(result.status)).toContain('登录、权限和连接');
    expect(enterpriseKnowledgeLookupNotice(result.status)).not.toContain('secret');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['ready', 'skipped'] as const)('does not invent an error for %s', (status) => {
    expect(enterpriseKnowledgeLookupNotice(status)).toBeNull();
  });
});

describe('enterprise knowledge prompt context', () => {
  it.each([10, 100])('labels observed evidence and its age without calling a self-description verified (%s days)', (days) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T00:00:00Z'));
    const observed = new Date(Date.now() - days * 86_400_000).toISOString();
    const context = buildEnterpriseKnowledgePromptContext([{
      id: 'observed', organizationId: 'org', sourceId: null, title: null,
      department: '', category: 'policy', content: '应复核操作依据', contributor: null,
      confidence: 0.9, status: 'active', version: 0, sourceType: 'auto_capture',
      evidenceCount: 4, distinctSessionCount: 3, distinctContributorCount: 2,
      verifiedEvidenceCount: 1, lastObservedAt: observed, createdAt: observed,
    }]);
    expect(context).toContain('组织可靠度 90%');
    expect(context).toContain('4 条证据；3 个会话；2 名贡献者；1 条已验证');
    expect(context.includes('超过 90 天')).toBe(days > 90);
    vi.useRealTimers();
  });

  it('formats missing optional evidence and an invalid observation date safely', () => {
    const context = buildEnterpriseKnowledgePromptContext([{
      id: 'empty', organizationId: 'org', sourceId: null, department: null,
      category: 'policy', content: '', contributor: null, status: 'active',
      sourceType: 'auto_capture', createdAt: 'invalid-date',
    }]);
    expect(context).toContain('范围：全组织');
    expect(context).not.toContain('证据：');
  });

  it('includes citations and excludes pending or archived records', () => {
    const context = buildEnterpriseKnowledgePromptContext([
      {
        id: '12', organizationId: 'org-1', sourceId: 'policy-1', title: '合同审批规则',
        department: '法务部', category: 'policy', content: '合同必须经过法务复核。',
        contributor: '管理员', confidence: 0.95, status: 'active', version: 3,
        sourceLabel: '员工手册 2026', createdAt: '2026-07-01T00:00:00.000Z',
      },
      {
        id: '13', organizationId: 'org-1', sourceId: 'candidate-1', title: '未经确认',
        department: '法务部', category: 'draft', content: '不能进入回答。',
        contributor: '成员', confidence: 0.8, status: 'pending_review', version: 1,
        createdAt: '2026-07-02T00:00:00.000Z',
      },
    ]);

    expect(context).toContain('[企业知识#12 v3]');
    expect(context).toContain('员工手册 2026');
    expect(context).not.toContain('不能进入回答');
  });

  it('excludes stale auto-captured memory from operational context', () => {
    const context = buildEnterpriseKnowledgePromptContext([{
      id: 'stale-1', organizationId: 'org-1', sourceId: 'retention-1', title: '旧部署流程',
      department: '研发部', category: 'solution', content: '生产部署使用旧网关。',
      contributor: null, confidence: 0.74, status: 'active', version: 2,
      sourceType: 'auto_capture', evidenceCount: 4, distinctSessionCount: 4,
      distinctContributorCount: 2, verifiedEvidenceCount: 1,
      lastObservedAt: '2020-01-01T00:00:00.000Z', createdAt: '2020-01-01T00:00:00.000Z',
    }]);

    expect(context).not.toContain('生产部署使用旧网关');
    expect(context).toContain('已排除 1 条不可直接使用的企业记忆');
    expect(context).toContain('超过 180 天未获新证据');
  });

  it('fails closed when an active record still carries a conflict marker', () => {
    const context = buildEnterpriseKnowledgePromptContext([{
      id: 'conflict-1', organizationId: 'org-1', sourceId: 'retention-conflict',
      title: '生产认证规则', department: '安全部', category: 'convention',
      content: '生产环境禁止启用双因素认证。', contributor: null,
      confidence: 0.3, status: 'active', version: 3, sourceType: 'auto_capture',
      sourceLabel: '证据存在冲突，需人工裁决', createdAt: new Date().toISOString(),
    }]);

    expect(context).not.toContain('生产环境禁止启用双因素认证');
    expect(context).toContain('存在尚未裁决的证据冲突');
  });

  it('bounds context size', () => {
    const context = buildEnterpriseKnowledgePromptContext(Array.from({ length: 20 }, (_, index) => ({
      id: String(index), organizationId: 'org-1', sourceId: null, department: null,
      category: 'long', content: 'x'.repeat(2_000), contributor: null,
      confidence: 1, status: 'active' as const, createdAt: '2026-07-01T00:00:00.000Z',
    })));
    expect(context.length).toBeLessThanOrEqual(8_000);
  });
});
