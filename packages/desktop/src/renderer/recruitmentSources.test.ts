/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it } from 'vitest';

import {
  buildRecruitmentSourceStates,
  createManualCandidateSource,
  mergeRecruitmentRuntimeSources,
  RECRUITMENT_SOURCE_CATALOG,
} from './recruitmentSources.js';

describe('招聘多来源连接器目录', () => {
  it('Workable 官方工具需要企业授权与岗位绑定，不因发现 MCP 就显示已接通', () => {
    const servers = [{ name: 'workable', status: 'connected' as const, trust: true }];
    const tools = ['get_accounts', 'get_candidates', 'get_candidate', 'send_outreach'].map((name) => ({ name: `workable__${name}`, serverName: 'workable' }));
    const state = buildRecruitmentSourceStates(servers, tools).find((item) => item.source.id === 'workable');
    expect(state).toMatchObject({ readiness: 'configuration_required', statusLabel: '待绑定与验收', missingRequiredTools: [], capabilities: { automaticSearch: false, sendOutreach: false } });
    expect(state?.statusDetail).toContain('岗位');
    expect(buildRecruitmentSourceStates([], []).find((item) => item.source.id === 'workable')?.statusDetail).toContain('OAuth');
    const merged = mergeRecruitmentRuntimeSources(buildRecruitmentSourceStates(servers, tools), [{ id: 'workable', label: 'Workable', accessMode: 'authorized_mcp', capabilities: ['search_candidates', 'get_candidate'], productionEnabled: true, authorized: true, searchable: true, status: 'ready', authorizationEvidenceRecorded: true }]);
    expect(merged.find((item) => item.source.id === 'workable')).toMatchObject({ statusLabel: '可读取绑定岗位', capabilities: { automaticSearch: true, sendOutreach: false } });
  });

  it('覆盖综合、技术、校招、公共、国际和企业自有来源', () => {
    const ids = new Set(RECRUITMENT_SOURCE_CATALOG.map((source) => source.id));
    for (const id of ['manual_upload', 'boss', 'zhaopin', '51job', 'liepin', 'lagou', 'maimai', 'nowcoder', 'shixiseng', 'ncss', 'iguopin', 'linkedin', 'indeed']) {
      expect(ids.has(id)).toBe(true);
    }
    expect(new Set(RECRUITMENT_SOURCE_CATALOG.map((source) => source.category))).toEqual(
      new Set(['owned', 'general', 'technology', 'campus', 'public', 'international']),
    );
  });

  it('没有官方连接时绝不把招聘平台标记为自动寻才', () => {
    const states = buildRecruitmentSourceStates([], []);
    expect(states.find((state) => state.source.id === 'manual_upload')).toMatchObject({
      readiness: 'ready',
      statusLabel: '现在可用',
    });
    expect(states.filter((state) => state.source.setup === 'mcp_or_official_api'))
      .toSatisfy((items: typeof states) => items.every((item) => !item.capabilities.automaticSearch));
  });

  it('只在同一已连接 MCP 同时提供搜索和详情工具时启用自动寻才', () => {
    const servers = [{ name: 'liepin-recruitment', status: 'connected' as const, description: '猎聘企业连接器', trust: true }];
    const incomplete = buildRecruitmentSourceStates(servers, [{
      name: 'liepin-recruitment__search_candidates', serverName: 'liepin-recruitment',
    }]).find((state) => state.source.id === 'liepin');
    expect(incomplete).toMatchObject({ readiness: 'incomplete', statusLabel: '连接不完整' });
    expect(incomplete?.missingRequiredTools).toContain('get_candidate');

    const ready = buildRecruitmentSourceStates(servers, [
      { name: 'liepin-recruitment__search_candidates', serverName: 'liepin-recruitment' },
      { name: 'liepin-recruitment__get_candidate', serverName: 'liepin-recruitment' },
      { name: 'liepin-recruitment__send_outreach', serverName: 'liepin-recruitment' },
    ]).find((state) => state.source.id === 'liepin');
    expect(ready).toMatchObject({
      readiness: 'connected',
      statusLabel: '可以自动寻才',
      capabilities: { automaticSearch: true, sendOutreach: true },
    });
    expect(ready?.statusDetail).toContain('仍需招聘人员确认');
  });

  it('相似名称但未连接的服务器不能获得自动搜索能力', () => {
    const state = buildRecruitmentSourceStates([{
      name: 'boss-helper', status: 'disconnected', description: 'BOSS直聘候选人助手', trust: true,
    }], [
      { name: 'boss-helper__search_candidates', serverName: 'boss-helper' },
      { name: 'boss-helper__get_candidate', serverName: 'boss-helper' },
    ]).find((item) => item.source.id === 'boss');
    expect(state).toMatchObject({ readiness: 'incomplete', statusLabel: '连接异常' });
    expect(state?.capabilities.automaticSearch).toBe(false);
  });

  it('未受信任的 MCP 即使工具齐全也不能自动读取候选人', () => {
    const state = buildRecruitmentSourceStates([{
      name: 'zhaopin-enterprise', status: 'connected', description: '智联招聘连接器', trust: false,
    }], [
      { name: 'zhaopin-enterprise__search_candidates', serverName: 'zhaopin-enterprise' },
      { name: 'zhaopin-enterprise__get_candidate', serverName: 'zhaopin-enterprise' },
    ]).find((item) => item.source.id === 'zhaopin');
    expect(state).toMatchObject({ readiness: 'incomplete', statusLabel: '尚未信任' });
    expect(state?.capabilities.automaticSearch).toBe(false);
  });

  it('展示符合工具约定的自定义招聘 MCP，不要求写死平台名称', () => {
    const states = buildRecruitmentSourceStates([{
      name: 'partner-source', status: 'connected', description: '北极星人才连接器', trust: true,
    }], [
      { name: 'partner-source__search_candidates', serverName: 'partner-source' },
      { name: 'partner-source__get_candidate', serverName: 'partner-source' },
    ]);
    expect(states.find((item) => item.source.id === 'custom_mcp:partner-source')).toMatchObject({
      readiness: 'connected',
      statusLabel: '可以自动寻才',
      source: { label: '北极星人才连接器' },
    });
  });

  it('以企业服务器的生产授权为准，不让本地 MCP 状态越权', () => {
    const local = buildRecruitmentSourceStates([{
      name: 'boss-helper', status: 'connected', description: 'BOSS直聘', trust: true,
    }], [
      { name: 'boss-helper__search_candidates', serverName: 'boss-helper' },
      { name: 'boss-helper__get_candidate', serverName: 'boss-helper' },
    ]);
    const merged = mergeRecruitmentRuntimeSources(local, [{
      id: 'boss', label: 'BOSS直聘', accessMode: 'evaluation_only',
      capabilities: ['search_candidates', 'get_candidate'],
      productionEnabled: false, authorized: false, searchable: false,
      status: 'production_approval_required', authorizationEvidenceRecorded: false,
      reason: '连接器仅允许隔离评估',
    }]);
    expect(merged.find((state) => state.source.id === 'boss')).toMatchObject({
      readiness: 'official_authorization_required',
      statusLabel: '等待生产批准',
      capabilities: { automaticSearch: false, candidateDetail: false },
      serverName: '企业服务器',
    });
  });

  it('展示服务器登记的自定义正式来源并启用其已批准能力', () => {
    const merged = mergeRecruitmentRuntimeSources(buildRecruitmentSourceStates([], []), [{
      id: 'greenhouse', label: 'Greenhouse ATS', accessMode: 'official_api',
      capabilities: ['search_candidates', 'get_candidate', 'sync_candidates'],
      productionEnabled: true, authorized: true, searchable: true,
      status: 'ready', authorizationEvidenceRecorded: true,
    }]);
    expect(merged.find((state) => state.source.id === 'greenhouse')).toMatchObject({
      readiness: 'connected',
      statusLabel: '可以自动寻才',
      source: { category: 'general' },
      capabilities: { automaticSearch: true, candidateDetail: true, backgroundSync: true },
    });
  });

  it('为手动导入材料生成独立且可追溯的来源记录', () => {
    const first = createManualCandidateSource('候选人A.pdf', '2026-09-07T00:00:00.000Z');
    const second = createManualCandidateSource('候选人A.pdf', '2026-09-07T00:00:00.000Z');
    expect(first).toMatchObject({
      providerId: 'manual_upload',
      providerLabel: '手动导入',
      acquisitionMode: 'manual_upload',
      authorizationStatus: 'confirmed',
      originalFileName: '候选人A.pdf',
    });
    expect(first.id).not.toBe(second.id);
  });
});
