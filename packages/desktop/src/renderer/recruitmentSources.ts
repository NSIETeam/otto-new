/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type { RecruitmentSourceRuntimeView } from 'otto-server';

export type RecruitmentSourceCategory =
  | 'owned'
  | 'general'
  | 'technology'
  | 'campus'
  | 'public'
  | 'international';

export type RecruitmentSourceReadiness =
  | 'ready'
  | 'connected'
  | 'incomplete'
  | 'configuration_required'
  | 'official_authorization_required';

export interface RecruitmentMcpServerInfo {
  name: string;
  status: 'connected' | 'connecting' | 'disconnected';
  description?: string;
  trust?: boolean;
}

export interface RecruitmentMcpToolInfo {
  name: string;
  displayName?: string;
  description?: string;
  serverName?: string;
}

export interface RecruitmentSourceDefinition {
  id: string;
  label: string;
  category: RecruitmentSourceCategory;
  description: string;
  aliases: readonly string[];
  setup: 'built_in' | 'mcp_or_official_api' | 'planned_owned_channel';
}

export interface RecruitmentSourceCapabilities {
  automaticSearch: boolean;
  candidateDetail: boolean;
  backgroundSync: boolean;
  draftOutreach: boolean;
  sendOutreach: boolean;
  publishJob: boolean;
  scheduleInterview: boolean;
}

export interface RecruitmentSourceState {
  source: RecruitmentSourceDefinition;
  readiness: RecruitmentSourceReadiness;
  statusLabel: string;
  statusDetail: string;
  serverName?: string;
  capabilities: RecruitmentSourceCapabilities;
  missingRequiredTools: string[];
}

export type CandidateSourceAcquisitionMode =
  | 'manual_upload'
  | 'candidate_submission'
  | 'employee_referral'
  | 'authorized_api'
  | 'authorized_mcp';

export interface RecruitmentCandidateSource {
  id: string;
  providerId: string;
  providerLabel: string;
  acquisitionMode: CandidateSourceAcquisitionMode;
  authorizationStatus: 'confirmed' | 'provider_contract' | 'candidate_submitted';
  importedAt: string;
  observedAt: string;
  sourceRecordId?: string;
  sourceUrl?: string;
  originalFileName?: string;
}

export const RECRUITMENT_MCP_REQUIRED_TOOLS = [
  'search_candidates',
  'get_candidate',
] as const;

export const RECRUITMENT_MCP_OPTIONAL_TOOLS = [
  'sync_candidates',
  'draft_outreach',
  'send_outreach',
  'publish_job',
  'schedule_interview',
] as const;

const EMPTY_CAPABILITIES: RecruitmentSourceCapabilities = {
  automaticSearch: false,
  candidateDetail: false,
  backgroundSync: false,
  draftOutreach: false,
  sendOutreach: false,
  publishJob: false,
  scheduleInterview: false,
};

export const RECRUITMENT_SOURCE_CATALOG: readonly RecruitmentSourceDefinition[] = [
  {
    id: 'manual_upload', label: '手动导入', category: 'owned', setup: 'built_in',
    description: '批量导入 PDF、Word、文本简历以及面试音视频。', aliases: [],
  },
  {
    id: 'enterprise_talent_pool', label: '企业人才库', category: 'owned', setup: 'planned_owned_channel',
    description: '复用历史候选人、往届面试和经授权保留的人才档案。', aliases: ['人才库', 'talent pool', 'ats'],
  },
  {
    id: 'recruitment_mailbox', label: '招聘邮箱', category: 'owned', setup: 'planned_owned_channel',
    description: '从企业指定邮箱接收投递附件并进入待审核队列。', aliases: ['招聘邮箱', 'mail', 'email'],
  },
  {
    id: 'employee_referral', label: '员工推荐', category: 'owned', setup: 'planned_owned_channel',
    description: '员工提交候选人材料，来源、推荐人和授权状态一并留痕。', aliases: ['员工推荐', '内推', 'referral'],
  },
  {
    id: 'candidate_portal', label: '候选人投递页', category: 'owned', setup: 'planned_owned_channel',
    description: '按岗位生成投递链接，由候选人主动提交并确认授权。', aliases: ['投递页', 'career site', 'candidate portal'],
  },
  {
    id: 'workable', label: 'Workable', category: 'international', setup: 'mcp_or_official_api',
    description: '官方 MCP：读取企业授权账号中已绑定岗位的候选人，不是全站人才搜索。', aliases: ['workable'],
  },
  {
    id: 'boss', label: 'BOSS直聘', category: 'general', setup: 'mcp_or_official_api',
    description: '取得平台官方接口或商务授权后，才能自动搜索和同步。', aliases: ['boss直聘', 'boss zhipin', 'zhipin'],
  },
  {
    id: 'zhaopin', label: '智联招聘', category: 'general', setup: 'mcp_or_official_api',
    description: '适合综合职位、社会招聘和校园招聘来源。', aliases: ['智联招聘', 'zhaopin'],
  },
  {
    id: '51job', label: '前程无忧', category: 'general', setup: 'mcp_or_official_api',
    description: '适合综合职位和企业人才库来源。', aliases: ['前程无忧', '51job'],
  },
  {
    id: 'liepin', label: '猎聘', category: 'general', setup: 'mcp_or_official_api',
    description: '适合中高端人才、猎头和主动寻访来源。', aliases: ['猎聘', 'liepin'],
  },
  {
    id: 'lagou', label: '拉勾', category: 'technology', setup: 'mcp_or_official_api',
    description: '适合互联网、产品、设计与技术岗位。', aliases: ['拉勾', 'lagou'],
  },
  {
    id: 'maimai', label: '脉脉招聘', category: 'technology', setup: 'mcp_or_official_api',
    description: '适合技术、互联网和职业社交人才来源。', aliases: ['脉脉招聘', '脉脉', 'maimai'],
  },
  {
    id: 'nowcoder', label: '牛客招聘', category: 'technology', setup: 'mcp_or_official_api',
    description: '适合技术岗位、笔试面试和校园人才。', aliases: ['牛客招聘', '牛客', 'nowcoder'],
  },
  {
    id: 'shixiseng', label: '实习僧', category: 'campus', setup: 'mcp_or_official_api',
    description: '适合实习岗位和初入职场候选人。', aliases: ['实习僧', 'shixiseng'],
  },
  {
    id: 'ncss', label: '国家大学生就业服务平台', category: 'campus', setup: 'mcp_or_official_api',
    description: '面向高校毕业生和校园招聘，接入能力以官方授权为准。', aliases: ['24365', '国家大学生就业服务平台', 'ncss'],
  },
  {
    id: 'iguopin', label: '国聘', category: 'public', setup: 'mcp_or_official_api',
    description: '适合国企、央企及公共招聘信息来源。', aliases: ['国聘', 'iguopin'],
  },
  {
    id: 'linkedin', label: 'LinkedIn', category: 'international', setup: 'mcp_or_official_api',
    description: '适合跨境、海外和国际化岗位，需使用正式企业产品接口。', aliases: ['linkedin', '领英'],
  },
  {
    id: 'indeed', label: 'Indeed', category: 'international', setup: 'mcp_or_official_api',
    description: '适合海外职位与候选人来源，需使用正式授权接口。', aliases: ['indeed'],
  },
] as const;

function normalizedToolName(tool: RecruitmentMcpToolInfo): string {
  const name = tool.name.trim().toLowerCase();
  const serverPrefix = tool.serverName?.trim().toLowerCase();
  return serverPrefix && name.startsWith(`${serverPrefix}__`)
    ? name.slice(serverPrefix.length + 2)
    : name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
}

function serverMatchesSource(server: RecruitmentMcpServerInfo, source: RecruitmentSourceDefinition): boolean {
  const haystack = `${server.name} ${server.description ?? ''}`.toLowerCase();
  return source.aliases.some((alias) => haystack.includes(alias.toLowerCase()));
}

function capabilitiesForTools(toolNames: ReadonlySet<string>): RecruitmentSourceCapabilities {
  const candidateDetail = toolNames.has('get_candidate');
  return {
    automaticSearch: toolNames.has('search_candidates') && candidateDetail,
    candidateDetail,
    backgroundSync: toolNames.has('sync_candidates'),
    draftOutreach: toolNames.has('draft_outreach'),
    sendOutreach: toolNames.has('send_outreach'),
    publishJob: toolNames.has('publish_job'),
    scheduleInterview: toolNames.has('schedule_interview'),
  };
}

function stateForConnectedServer(
  source: RecruitmentSourceDefinition,
  server: RecruitmentMcpServerInfo,
  tools: readonly RecruitmentMcpToolInfo[],
): RecruitmentSourceState {
  const serverTools = new Set(tools
    .filter((tool) => tool.serverName === server.name)
    .map(normalizedToolName));
  const capabilities = capabilitiesForTools(serverTools);
  const requiredTools = source.id === 'workable' ? ['get_accounts', 'get_candidates', 'get_candidate'] : RECRUITMENT_MCP_REQUIRED_TOOLS;
  const missingRequiredTools = requiredTools.filter((name) => !serverTools.has(name));

  if (!server.trust) {
    return {
      source,
      readiness: 'incomplete',
      statusLabel: '尚未信任',
      statusDetail: '连接器尚未通过企业管理员信任审核，不能读取候选人数据。',
      serverName: server.name,
      capabilities: { ...EMPTY_CAPABILITIES },
      missingRequiredTools,
    };
  }
  if (server.status !== 'connected') {
    return {
      source,
      readiness: 'incomplete',
      statusLabel: server.status === 'connecting' ? '正在连接' : '连接异常',
      statusDetail: '已找到对应连接器，但当前没有建立可用连接。',
      serverName: server.name,
      capabilities: { ...EMPTY_CAPABILITIES },
      missingRequiredTools,
    };
  }
  if (missingRequiredTools.length > 0) {
    return {
      source,
      readiness: 'incomplete',
      statusLabel: '连接不完整',
      statusDetail: `连接器还缺少 ${missingRequiredTools.join('、')}，不能自动寻才。`,
      serverName: server.name,
      capabilities: source.id === 'workable' ? { ...EMPTY_CAPABILITIES } : capabilities,
      missingRequiredTools,
    };
  }
  if (source.id === 'workable') {
    return { source, readiness: 'configuration_required', statusLabel: '待绑定与验收',
      statusDetail: '已发现官方工具名称；仍需在企业服务器完成 OAuth 授权、账号与共享岗位绑定以及真实账号验收。当前不自动联系候选人。',
      serverName: server.name, capabilities: { ...EMPTY_CAPABILITIES }, missingRequiredTools: [] };
  }
  return {
    source,
    readiness: 'connected',
    statusLabel: '可以自动寻才',
    statusDetail: capabilities.sendOutreach
      ? '已验证候选人搜索与详情工具；发送消息仍需招聘人员确认。'
      : '已验证候选人搜索与详情工具。',
    serverName: server.name,
    capabilities,
    missingRequiredTools: [],
  };
}

export function buildRecruitmentSourceStates(
  servers: readonly RecruitmentMcpServerInfo[],
  tools: readonly RecruitmentMcpToolInfo[],
): RecruitmentSourceState[] {
  const catalogStates = RECRUITMENT_SOURCE_CATALOG.map<RecruitmentSourceState>((source) => {
    if (source.setup === 'built_in') {
      return {
        source,
        readiness: 'ready',
        statusLabel: '现在可用',
        statusDetail: '文件由用户主动选择，导入时记录授权与来源。',
        capabilities: { ...EMPTY_CAPABILITIES, candidateDetail: true },
        missingRequiredTools: [],
      };
    }
    const matchingServer = servers.find((server) => serverMatchesSource(server, source));
    if (matchingServer) return stateForConnectedServer(source, matchingServer, tools);
    if (source.id === 'workable') {
      return { source, readiness: 'configuration_required', statusLabel: '待授权与验收',
        statusDetail: '只读适配已具备。需要企业 OAuth 授权、Workable 账号和共享岗位绑定；尚未通过真实账号验收。简历全文附件读取另行验收。',
        capabilities: { ...EMPTY_CAPABILITIES }, missingRequiredTools: ['get_accounts', 'get_candidates', 'get_candidate'] };
    }
    if (source.setup === 'planned_owned_channel') {
      return {
        source,
        readiness: 'configuration_required',
        statusLabel: '需要配置',
        statusDetail: '连接企业自有系统或安装符合招聘 MCP v1 约定的连接器后启用。',
        capabilities: { ...EMPTY_CAPABILITIES },
        missingRequiredTools: [...RECRUITMENT_MCP_REQUIRED_TOOLS],
      };
    }
    return {
      source,
      readiness: 'official_authorization_required',
      statusLabel: '等待官方授权',
      statusDetail: '可继续手动导入；自动搜索必须先取得平台官方接口或商务授权。',
      capabilities: { ...EMPTY_CAPABILITIES },
      missingRequiredTools: [...RECRUITMENT_MCP_REQUIRED_TOOLS],
    };
  });
  const catalogServerNames = new Set(servers
    .filter((server) => RECRUITMENT_SOURCE_CATALOG.some((source) => serverMatchesSource(server, source)))
    .map((server) => server.name));
  const recruitmentToolNames = new Set<string>([
    ...RECRUITMENT_MCP_REQUIRED_TOOLS,
    ...RECRUITMENT_MCP_OPTIONAL_TOOLS,
  ]);
  const customStates = servers.flatMap((server) => {
    if (catalogServerNames.has(server.name)) return [];
    const hasRecruitmentTool = tools.some((tool) => (
      tool.serverName === server.name && recruitmentToolNames.has(normalizedToolName(tool))
    ));
    if (!hasRecruitmentTool) return [];
    const source: RecruitmentSourceDefinition = {
      id: `custom_mcp:${server.name}`,
      label: server.description?.trim() || `自定义招聘 MCP · ${server.name}`,
      category: 'owned',
      description: '用户安装的招聘来源连接器；能力按照实际发现的工具逐项验证。',
      aliases: [],
      setup: 'mcp_or_official_api',
    };
    return [stateForConnectedServer(source, server, tools)];
  });
  return [...catalogStates, ...customStates];
}

function runtimeReadiness(source: RecruitmentSourceRuntimeView): RecruitmentSourceReadiness {
  if (source.searchable) return 'connected';
  return source.status === 'organization_authorization_required'
    || source.status === 'connector_capability_required'
    ? 'configuration_required'
    : 'official_authorization_required';
}

function runtimeStatusLabel(source: RecruitmentSourceRuntimeView): string {
  if (source.id === 'workable' && source.searchable) return '可读取绑定岗位';
  if (source.searchable) return '可以自动寻才';
  if (source.status === 'connector_capability_required') return '连接能力不完整';
  return source.status === 'organization_authorization_required'
    ? '需要企业授权'
    : '等待生产批准';
}

/**
 * The server is the authority for production access. Local MCP discovery remains
 * useful for setup diagnostics, but can never overrule a server-side denial.
 */
export function mergeRecruitmentRuntimeSources(
  localStates: readonly RecruitmentSourceState[],
  runtimeSources: readonly RecruitmentSourceRuntimeView[],
): RecruitmentSourceState[] {
  const runtimeById = new Map(runtimeSources.map((source) => [source.id, source]));
  const merged = localStates.map((state) => {
    const runtime = runtimeById.get(state.source.id);
    if (!runtime) return state;
    runtimeById.delete(state.source.id);
    const capabilities = new Set(runtime.capabilities);
    return {
      ...state,
      readiness: runtimeReadiness(runtime),
      statusLabel: runtimeStatusLabel(runtime),
      statusDetail: runtime.reason ?? (runtime.searchable
        ? runtime.id === 'workable' ? '仅读取当前共享岗位绑定的 Workable 候选人；不是全站人才搜索。资料摘要不等于简历全文，不自动联系候选人。'
          : '企业服务器已验证平台授权、组织权限与候选人搜索能力。'
        : '企业服务器尚未批准读取该来源的真实候选人数据。'),
      serverName: '企业服务器',
      capabilities: {
        automaticSearch: runtime.searchable && capabilities.has('search_candidates'),
        candidateDetail: runtime.searchable && capabilities.has('get_candidate'),
        backgroundSync: runtime.searchable && capabilities.has('sync_candidates'),
        draftOutreach: runtime.searchable && capabilities.has('draft_outreach'),
        sendOutreach: runtime.searchable && capabilities.has('send_outreach'),
        publishJob: runtime.searchable && capabilities.has('publish_job'),
        scheduleInterview: runtime.searchable && capabilities.has('schedule_interview'),
      },
      missingRequiredTools: runtime.searchable
        ? RECRUITMENT_MCP_REQUIRED_TOOLS.filter((name) => !capabilities.has(name))
        : [...RECRUITMENT_MCP_REQUIRED_TOOLS],
    };
  });
  for (const runtime of runtimeById.values()) {
    const capabilities = new Set(runtime.capabilities);
    merged.push({
      source: {
        id: runtime.id,
        label: runtime.label,
        category: runtime.accessMode === 'enterprise_owned' ? 'owned' : 'general',
        description: runtime.searchable
          ? '由企业服务器统一授权、检索并记录审计轨迹。'
          : '该来源已登记，但尚未取得当前企业的生产访问授权。',
        aliases: [runtime.id],
        setup: runtime.accessMode === 'enterprise_owned'
          ? 'planned_owned_channel'
          : 'mcp_or_official_api',
      },
      readiness: runtimeReadiness(runtime),
      statusLabel: runtimeStatusLabel(runtime),
      statusDetail: runtime.reason ?? '以企业服务器授权状态为准。',
      serverName: '企业服务器',
      capabilities: {
        automaticSearch: runtime.searchable && capabilities.has('search_candidates'),
        candidateDetail: runtime.searchable && capabilities.has('get_candidate'),
        backgroundSync: runtime.searchable && capabilities.has('sync_candidates'),
        draftOutreach: runtime.searchable && capabilities.has('draft_outreach'),
        sendOutreach: runtime.searchable && capabilities.has('send_outreach'),
        publishJob: runtime.searchable && capabilities.has('publish_job'),
        scheduleInterview: runtime.searchable && capabilities.has('schedule_interview'),
      },
      missingRequiredTools: runtime.searchable
        ? RECRUITMENT_MCP_REQUIRED_TOOLS.filter((name) => !capabilities.has(name))
        : [...RECRUITMENT_MCP_REQUIRED_TOOLS],
    });
  }
  return merged;
}

export function createManualCandidateSource(
  originalFileName: string,
  now = new Date().toISOString(),
): RecruitmentCandidateSource {
  return {
    id: `candidate-source:${crypto.randomUUID()}`,
    providerId: 'manual_upload',
    providerLabel: '手动导入',
    acquisitionMode: 'manual_upload',
    authorizationStatus: 'confirmed',
    importedAt: now,
    observedAt: now,
    originalFileName,
  };
}

export function categoryLabel(category: RecruitmentSourceCategory): string {
  if (category === 'owned') return '企业自有来源';
  if (category === 'general') return '综合招聘平台';
  if (category === 'technology') return '技术与互联网';
  if (category === 'campus') return '实习与校招';
  if (category === 'public') return '公共与国企招聘';
  return '国际招聘';
}
