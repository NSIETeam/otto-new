/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryPolicyIntelligenceStore,
  PolicyIntelligenceService,
  extractOfficialPolicyLinks,
} from './policyIntelligenceService.js';

const LIST_URL = 'https://kw.beijing.gov.cn/zwgk/zwgksbrl/';
const DETAIL_URL = 'https://kw.beijing.gov.cn/zwgk/zwgksbrl/202609/t20260901_1.html';

function response(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

describe('政策智能服务', () => {
  it('只提取 HTTPS 官方白名单内的政策链接并去重', () => {
    const links = extractOfficialPolicyLinks([
      '<a href="/zwgk/zwgksbrl/202609/t20260901_1.html">软件企业申报通知</a>',
      '<a href="/zwgk/zwgksbrl/202609/t20260901_1.html">软件企业申报通知</a>',
      '<a href="https://evil.example/申报">伪造申报通知</a>',
      '<a href="http://kw.beijing.gov.cn/plain">不安全链接</a>',
    ].join(''), LIST_URL, ['kw.beijing.gov.cn']);

    expect(links).toEqual([{ url: DETAIL_URL, title: '软件企业申报通知' }]);
  });

  it('默认关闭时不联网也不调用模型', async () => {
    const fetchImpl = vi.fn();
    const analyze = vi.fn();
    const service = new PolicyIntelligenceService({
      store: new InMemoryPolicyIntelligenceStore(), fetchImpl, analyze,
      sources: [{ id: 'science', name: '北京市科委', listUrl: LIST_URL, allowedHosts: ['kw.beijing.gov.cn'] }],
    });

    await service.configure({
      scopeId: 'org-a', enabled: false,
      profile: { organizationName: '甲公司' },
    });
    const state = await service.sync('org-a', 'manual');

    expect(state.enabled).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
  });

  it('同一政策内容未变化时不重复调用模型消耗 token', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return url === LIST_URL
        ? response(`<a href="${DETAIL_URL}">软件企业研发补助项目申报通知</a>`)
        : response('<h1>软件企业研发补助项目申报通知</h1><p>注册地在北京市，主营软件，研发投入达到要求。申报截止2026年9月30日。</p>');
    });
    const analyze = vi.fn(async () => ({
      status: 'likely_eligible' as const,
      score: 88,
      summary: '企业所在地和行业初步匹配。',
      conditions: [{ label: '注册地在北京市', result: 'met' as const, evidence: '企业注册地为北京市昌平区' }],
      gaps: [], missingFields: [], resourceConnections: ['北京市科技计划综合管理平台'],
    }));
    const service = new PolicyIntelligenceService({
      store: new InMemoryPolicyIntelligenceStore(), fetchImpl, analyze,
      sources: [{ id: 'science', name: '北京市科委', listUrl: LIST_URL, allowedHosts: ['kw.beijing.gov.cn'] }],
    });
    await service.configure({
      scopeId: 'org-a', enabled: true,
      profile: { organizationName: '甲公司', registeredRegion: '北京市昌平区', industry: '软件服务' },
    });

    await service.sync('org-a', 'manual');
    await service.sync('org-a', 'manual');

    expect(analyze).toHaveBeenCalledTimes(1);
    expect((await service.getState('org-a')).assessments[0]).toMatchObject({ status: 'likely_eligible', score: 88 });
  });

  it('企业关键资料不足时先列缺口，不调用模型猜测', async () => {
    const analyze = vi.fn();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input) === LIST_URL
      ? response(`<a href="${DETAIL_URL}">科技项目申报通知</a>`)
      : response('<h1>科技项目申报通知</h1><p>企业项目征集，申报截止2026年9月30日。</p>'));
    const service = new PolicyIntelligenceService({
      store: new InMemoryPolicyIntelligenceStore(), fetchImpl, analyze,
      sources: [{ id: 'science', name: '北京市科委', listUrl: LIST_URL, allowedHosts: ['kw.beijing.gov.cn'] }],
    });
    await service.configure({ scopeId: 'org-a', enabled: true, profile: { organizationName: '甲公司' } });

    const state = await service.sync('org-a', 'manual');

    expect(analyze).not.toHaveBeenCalled();
    expect(state.assessments[0]).toMatchObject({ status: 'unknown', missingFields: ['registeredRegion', 'industry'] });
  });

  it('退出同步只抓取不调用模型，并在下次启动补做分析', async () => {
    const analyze = vi.fn(async () => ({
      status: 'likely_eligible' as const, score: 80, summary: '初步匹配',
      conditions: [], gaps: [], missingFields: [], resourceConnections: [],
    }));
    const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input) === LIST_URL
      ? response(`<a href="${DETAIL_URL}">科技项目申报通知</a>`)
      : response('<h1>科技项目申报通知</h1><p>北京软件企业项目申报。</p>'));
    const service = new PolicyIntelligenceService({
      store: new InMemoryPolicyIntelligenceStore(), fetchImpl, analyze,
      sources: [{ id: 'science', name: '北京市科委', listUrl: LIST_URL, allowedHosts: ['kw.beijing.gov.cn'] }],
    });
    await service.configure({
      scopeId: 'org-a', enabled: true,
      profile: { organizationName: '甲公司', registeredRegion: '北京市', industry: '软件' },
    });

    const shutdown = await service.sync('org-a', 'shutdown');
    expect(analyze).not.toHaveBeenCalled();
    expect(shutdown.assessments[0].summary).toContain('下次启动');
    const startup = await service.sync('org-a', 'startup');
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(startup.assessments[0].status).toBe('likely_eligible');
  });

  it('一个官方源故障时仍保留其他官方源的结果并显示部分失败', async () => {
    const brokenUrl = 'https://www.gov.cn/zhengce/zhengceku/';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === brokenUrl) throw new Error('temporary failure');
      if (url === LIST_URL) return response(`<a href="${DETAIL_URL}">科技项目申报通知</a>`);
      return response('<h1>科技项目申报通知</h1><p>北京软件企业项目申报。</p>');
    });
    const service = new PolicyIntelligenceService({
      store: new InMemoryPolicyIntelligenceStore(), fetchImpl,
      analyze: vi.fn(async () => ({ status: 'unknown' as const, score: 10, summary: '待核验', conditions: [], gaps: [], missingFields: [], resourceConnections: [] })),
      sources: [
        { id: 'broken', name: '国务院政策文件库', listUrl: brokenUrl, allowedHosts: ['www.gov.cn'] },
        { id: 'science', name: '北京市科委', listUrl: LIST_URL, allowedHosts: ['kw.beijing.gov.cn'] },
      ],
    });
    await service.configure({ scopeId: 'org-a', enabled: true, profile: { registeredRegion: '北京市', industry: '软件' } });

    const state = await service.sync('org-a', 'manual');

    expect(state.policies).toHaveLength(1);
    expect(state.syncStatus).toBe('idle');
    expect(state.lastError).toContain('国务院政策文件库');
  });
});
