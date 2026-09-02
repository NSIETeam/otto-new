/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { EnterpriseOrganizationFeatures } from '../preload/index.js';
import type { AgentProfile } from './agents/departmentAgents.js';
import type { CustomAgentDefinition } from './customAgents.js';
import type { ModuleIconKey, ModuleIconSource } from './components/ModuleIcon.js';
import {
  LOCAL_USER_PUBLISHER_ID,
  OTTO_OFFICIAL_PUBLISHER_ID,
  type ComponentPackageReference,
} from './modulePackages.js';

export type ModuleAvailability = 'available' | 'disabled' | 'hidden';
export type ModuleCategory =
  | 'common'
  | 'park'
  | 'recruitment'
  | 'capability'
  | 'custom-agent'
  | 'customer-module';

export interface InstalledCustomerModuleSummary {
  id: string;
  version: string;
  name: string;
  description: string;
  enabled: boolean;
  suspendedReason?: string;
  iconSrc?: string;
}

export type ParkModuleTarget =
  | 'overview'
  | 'announcement'
  | 'satisfaction'
  | 'renovation'
  | 'parking'
  | 'network-phone'
  | 'meeting-room'
  | 'electric-card'
  | 'repair'
  | 'vehicle-visit'
  | 'enterprise-star-map'
  | 'staff-tasks'
  | 'my-applications';

export type RecruitmentModuleTarget =
  | 'resume-analysis'
  | 'candidate-screening'
  | 'evidence-graph'
  | 'interview-audio'
  | 'interview-kit'
  | 'interview-copilot'
  | 'work-sample'
  | 'privacy-audit';

export type ModuleActivation =
  | { kind: 'dialog'; dialog: 'park'; target: ParkModuleTarget }
  | { kind: 'dialog'; dialog: 'recruitment'; target: RecruitmentModuleTarget }
  | { kind: 'dialog'; dialog: 'enterprise-memory' | 'auto-skill' | 'policy-intelligence' | 'park-carpool' }
  | { kind: 'route'; route: 'skill-zone' }
  | { kind: 'agent'; profileId: string; customAgentId?: string }
  | { kind: 'customer-module'; moduleId: string; version: string };

export interface ParkModuleAuthorization {
  hasParkContext: boolean;
  canViewStatistics: boolean;
  canViewStaffTasks: boolean;
  canUseCarpool?: boolean;
  disabledReason?: string;
}

export interface ModuleCatalogContext {
  edition: 'personal' | 'enterprise';
  profiles: readonly AgentProfile[];
  organizationFeatures: EnterpriseOrganizationFeatures | null;
  parkAuthorization: ParkModuleAuthorization;
  customAgents: readonly CustomAgentDefinition[];
  customerModules?: readonly InstalledCustomerModuleSummary[];
}

export interface ModuleDefinition {
  id: string;
  label: string;
  description?: string;
  category: ModuleCategory;
  icon: ModuleIconSource;
  activation: ModuleActivation;
  availability: ModuleAvailability;
  disabledReason?: string;
  package?: ComponentPackageReference;
}

type StaticAvailabilityRule =
  | 'park'
  | 'park-statistics'
  | 'park-staff'
  | 'park-carpool'
  | 'recruitment'
  | 'enterprise-memory'
  | 'auto-skill'
  | 'policy-intelligence'
  | 'skill-zone';

interface StaticModuleSpec extends Omit<ModuleDefinition, 'availability' | 'disabledReason' | 'package'> {
  availabilityRule: StaticAvailabilityRule;
}

export const STATIC_MODULE_SPECS: readonly StaticModuleSpec[] = [
  {
    id: 'park-overview', label: '园区服务统计', category: 'park', icon: 'park-overview',
    activation: { kind: 'dialog', dialog: 'park', target: 'overview' },
    availabilityRule: 'park-statistics',
  },
  {
    id: 'park-announcement', label: '园区公告', category: 'park', icon: 'park-announcement',
    activation: { kind: 'dialog', dialog: 'park', target: 'announcement' },
    availabilityRule: 'park',
  },
  {
    id: 'park-satisfaction', label: '满意度调查', category: 'park', icon: 'park-satisfaction',
    activation: { kind: 'dialog', dialog: 'park', target: 'satisfaction' },
    availabilityRule: 'park',
  },
  {
    id: 'park-renovation', label: '装修管理', category: 'park', icon: 'park-renovation',
    activation: { kind: 'dialog', dialog: 'park', target: 'renovation' },
    availabilityRule: 'park',
  },
  {
    id: 'park-parking', label: '停车办理', category: 'park', icon: 'park-parking',
    activation: { kind: 'dialog', dialog: 'park', target: 'parking' },
    availabilityRule: 'park',
  },
  {
    id: 'park-network-phone', label: '网络与固话', category: 'park', icon: 'park-network-phone',
    activation: { kind: 'dialog', dialog: 'park', target: 'network-phone' },
    availabilityRule: 'park',
  },
  {
    id: 'park-meeting-room', label: '会议室预约', category: 'park', icon: 'park-meeting-room',
    activation: { kind: 'dialog', dialog: 'park', target: 'meeting-room' },
    availabilityRule: 'park',
  },
  {
    id: 'park-electric-card', label: '电卡服务', category: 'park', icon: 'park-electric-card',
    activation: { kind: 'dialog', dialog: 'park', target: 'electric-card' },
    availabilityRule: 'park',
  },
  {
    id: 'park-repair', label: '物业报修', category: 'park', icon: 'park-repair',
    activation: { kind: 'dialog', dialog: 'park', target: 'repair' },
    availabilityRule: 'park',
  },
  {
    id: 'park-vehicle-visit', label: '车辆与访客', category: 'park', icon: 'park-vehicle-visit',
    activation: { kind: 'dialog', dialog: 'park', target: 'vehicle-visit' },
    availabilityRule: 'park',
  },
  {
    id: 'park-enterprise-star-map', label: '企业星链图', category: 'park', icon: 'park-overview',
    description: '根据同园区企业主动公开的能力、产品与合作需求，生成可解释的合作线索。',
    activation: { kind: 'dialog', dialog: 'park', target: 'enterprise-star-map' },
    availabilityRule: 'park',
  },
  {
    id: 'park-carpool', label: '拼车助手', category: 'park', icon: 'park-carpool',
    description: '发布当日出行意向，匹配同园区内路线与时间相近的同行伙伴。',
    activation: { kind: 'dialog', dialog: 'park-carpool' },
    availabilityRule: 'park-carpool',
  },
  {
    id: 'park-staff-tasks', label: '园区待办', category: 'park', icon: 'park-staff-tasks',
    activation: { kind: 'dialog', dialog: 'park', target: 'staff-tasks' },
    availabilityRule: 'park-staff',
  },
  {
    id: 'park-my-applications', label: '我的申请', category: 'park', icon: 'park-my-applications',
    activation: { kind: 'dialog', dialog: 'park', target: 'my-applications' },
    availabilityRule: 'park',
  },
  {
    id: 'recruitment-resume-analysis', label: '开始智能招聘', category: 'recruitment',
    description: '用一句话说明招聘目标，再放入简历或面试视频，直接生成可回查的候选人档案。',
    icon: 'generated:agent-hr-recruiting',
    activation: { kind: 'dialog', dialog: 'recruitment', target: 'resume-analysis' },
    availabilityRule: 'recruitment',
  },
  {
    id: 'recruitment-candidate-screening', label: '候选人档案', category: 'recruitment',
    description: '查看候选人结论、优势、风险、待核实事项和简历或面试原文证据。',
    icon: 'generated:agent-hr-recruiting',
    activation: { kind: 'dialog', dialog: 'recruitment', target: 'candidate-screening' },
    availabilityRule: 'recruitment',
  },
  {
    id: 'recruitment-evidence-graph', label: '岗位证据图谱', category: 'recruitment',
    description: '按企业真实岗位标准，把简历、面试和实战成果整理成已验证、矛盾与待核实证据链。',
    icon: 'generated:agent-hr-recruiting',
    activation: { kind: 'dialog', dialog: 'recruitment', target: 'evidence-graph' },
    availabilityRule: 'recruitment',
  },
  {
    id: 'recruitment-interview-audio', label: '加入面试材料', category: 'recruitment',
    description: '把录音或视频加入当前候选人档案，与简历全文联合分析并核对差异。',
    icon: 'generated:agent-hr-recruiting',
    activation: { kind: 'dialog', dialog: 'recruitment', target: 'interview-audio' },
    availabilityRule: 'recruitment',
  },
  {
    id: 'recruitment-interview-kit', label: '面试与比较', category: 'recruitment',
    description: '生成针对性面试问题，并按同一岗位口径横向比较多位候选人。',
    icon: 'generated:agent-hr-recruiting',
    activation: { kind: 'dialog', dialog: 'recruitment', target: 'interview-kit' },
    availabilityRule: 'recruitment',
  },
  {
    id: 'recruitment-interview-copilot', label: '动态面试追问', category: 'recruitment',
    description: '根据当前证据缺口给出最值得问的下一题，并随面试材料补充自动更新。',
    icon: 'generated:agent-hr-recruiting',
    activation: { kind: 'dialog', dialog: 'recruitment', target: 'interview-copilot' },
    availabilityRule: 'recruitment',
  },
  {
    id: 'recruitment-work-sample', label: '岗位实战验证', category: 'recruitment',
    description: '生成贴近企业实际工作的任务和证据化评分规则，并把候选人成果回流到同一档案。',
    icon: 'generated:agent-hr-recruiting',
    activation: { kind: 'dialog', dialog: 'recruitment', target: 'work-sample' },
    availabilityRule: 'recruitment',
  },
  {
    id: 'recruitment-privacy-audit', label: '资料与隐私', category: 'recruitment',
    description: '管理授权、保存期限、模型版本、人工判断和敏感字段隔离。',
    icon: 'generated:agent-hr-recruiting',
    activation: { kind: 'dialog', dialog: 'recruitment', target: 'privacy-audit' },
    availabilityRule: 'recruitment',
  },
  {
    id: 'policy-intelligence', label: '政策智能服务', category: 'common', icon: 'generated:expert-research',
    description: '汇总官方政策，结合企业资料分析可申报项目、条件缺口、政策原文和资源对接。',
    activation: { kind: 'dialog', dialog: 'policy-intelligence' },
    availabilityRule: 'policy-intelligence',
  },
  {
    id: 'enterprise-memory', label: '企业记忆', category: 'capability', icon: 'enterprise-memory',
    description: '自动学习并调用企业制度、偏好、决定和解决方法，用证据地图识别冲突、过期与缺口，动态提示管理员下一步确认。',
    activation: { kind: 'dialog', dialog: 'enterprise-memory' },
    availabilityRule: 'enterprise-memory',
  },
  {
    id: 'auto-skill', label: '自动 Skill', category: 'capability', icon: 'auto-skill',
    activation: { kind: 'dialog', dialog: 'auto-skill' },
    availabilityRule: 'auto-skill',
  },
  {
    id: 'skill-zone', label: 'Skill 专区', category: 'capability', icon: 'skill-zone',
    activation: { kind: 'route', route: 'skill-zone' },
    availabilityRule: 'skill-zone',
  },
] as const;

const PROFILE_MODULE_IDS: Readonly<Record<string, string>> = {
  'otto-personal': 'agent-personal-otto',
  'otto-enterprise-work': 'agent-enterprise-work',
  'self-development': 'agent-self-development',
  ppt: 'agent-ppt',
  meeting: 'agent-meeting',
  doc: 'agent-word',
  sheet: 'agent-excel',
  pdf: 'agent-pdf',
  dataviz: 'agent-dataviz',
  research: 'agent-research',
  copy: 'agent-copy',
};

function staticAvailability(
  rule: StaticAvailabilityRule,
  context: ModuleCatalogContext,
): ModuleAvailability {
  if (rule === 'auto-skill') return 'available';
  if (context.edition !== 'enterprise') return 'hidden';

  if (rule === 'policy-intelligence') return 'available';

  if (rule === 'recruitment') return 'available';

  if (rule === 'enterprise-memory') {
    return context.organizationFeatures?.knowledge ? 'available' : 'hidden';
  }
  if (rule === 'skill-zone') {
    return context.organizationFeatures?.skill_market ? 'available' : 'hidden';
  }
  if (!context.organizationFeatures?.park_service || !context.parkAuthorization.hasParkContext) {
    return rule === 'park' ? 'disabled' : 'hidden';
  }
  if (rule === 'park-statistics' && !context.parkAuthorization.canViewStatistics) {
    return 'hidden';
  }
  if (rule === 'park-staff' && !context.parkAuthorization.canViewStaffTasks) {
    return 'hidden';
  }
  if (rule === 'park-carpool' && context.parkAuthorization.canUseCarpool !== true) {
    return 'hidden';
  }
  return 'available';
}

function staticDisabledReason(
  rule: StaticAvailabilityRule,
  context: ModuleCatalogContext,
): string | undefined {
  if ((rule !== 'park' && rule !== 'park-carpool') || context.edition !== 'enterprise') return undefined;
  if (!context.organizationFeatures?.park_service) return '当前企业尚未启用园区服务';
  if (!context.parkAuthorization.hasParkContext) {
    return context.parkAuthorization.disabledReason ?? '当前企业尚未绑定园区服务空间';
  }
  return undefined;
}

const PROFILE_LINE_ICONS: Readonly<Record<string, ModuleIconKey>> = {
  'otto-enterprise-work': 'office-work',
  ppt: 'office-presentation',
  meeting: 'office-meeting',
  doc: 'office-document',
  sheet: 'office-spreadsheet',
  pdf: 'office-pdf',
  dataviz: 'office-dataviz',
  research: 'office-research',
  copy: 'office-copywriting',
};

/**
 * Workspace modules deliberately use one theme-aware line-icon family.
 * Rich generated artwork remains available in galleries and custom-agent
 * pickers, but mixing it into the compact right rail causes inconsistent
 * optical weight and cannot follow system appearance reliably.
 */
export function profileModuleIcon(profile: AgentProfile): ModuleIconKey {
  if (profile.id === 'otto-personal') return 'otto-avatar';
  if (profile.id === 'self-development') return 'self-development';
  return PROFILE_LINE_ICONS[profile.id] ?? 'agent';
}

function profileIsAllowed(profile: AgentProfile, edition: ModuleCatalogContext['edition']): boolean {
  if (edition === 'personal') return profile.id === 'otto-personal';
  return profile.id !== 'otto-personal' && Boolean(PROFILE_MODULE_IDS[profile.id]);
}

function agentModules(context: ModuleCatalogContext): ModuleDefinition[] {
  return context.profiles
    .filter((profile) => profileIsAllowed(profile, context.edition))
    .flatMap((profile) => {
      const moduleId = PROFILE_MODULE_IDS[profile.id];
      if (!moduleId) return [];
      return [{
        id: moduleId,
        label: profile.name,
        description: profile.tagline,
        category: 'common' as const,
        icon: profileModuleIcon(profile),
        activation: { kind: 'agent' as const, profileId: profile.id },
        availability: 'available' as const,
        package: {
          source: 'official' as const,
          packageId: `otto.module.${moduleId}`,
          publisherId: OTTO_OFFICIAL_PUBLISHER_ID,
          version: '1.0.0',
        },
      }];
    });
}

function customAgentModules(context: ModuleCatalogContext): ModuleDefinition[] {
  const baseProfileId = context.edition === 'enterprise'
    ? 'otto-enterprise-work'
    : 'otto-personal';
  return context.customAgents.map((agent) => ({
    id: `agent-${agent.id}`,
    label: agent.name,
    description: agent.instructions,
    category: 'custom-agent',
    // Rich custom artwork stays in the editor/gallery. Compact workspace tiles
    // deliberately use the shared theme-aware semantic icon family.
    icon: 'agent',
    activation: {
      kind: 'agent',
      profileId: baseProfileId,
      customAgentId: agent.id,
    },
    availability: 'available',
    package: {
      source: 'user',
      packageId: `user.module.agent.${agent.id}`,
      publisherId: LOCAL_USER_PUBLISHER_ID,
      version: '1.0.0',
    },
  }));
}

function customerModules(context: ModuleCatalogContext): ModuleDefinition[] {
  return (context.customerModules ?? []).map((module) => ({
    id: `customer-module:${module.id}`,
    label: module.name,
    description: module.description,
    category: 'customer-module',
    icon: 'customer-module',
    activation: { kind: 'customer-module', moduleId: module.id, version: module.version },
    availability: module.enabled ? 'available' : 'disabled',
    ...(module.suspendedReason ? { disabledReason: module.suspendedReason } : {}),
  }));
}

export function buildModuleCatalog(context: ModuleCatalogContext): ModuleDefinition[] {
  const staticModules = STATIC_MODULE_SPECS.map(({ availabilityRule, ...module }) => ({
    ...module,
    availability: staticAvailability(availabilityRule, context),
    disabledReason: staticDisabledReason(availabilityRule, context),
    package: {
      source: 'official' as const,
      packageId: `otto.module.${module.id}`,
      publisherId: OTTO_OFFICIAL_PUBLISHER_ID,
      version: '1.0.0',
    },
  }));
  const result = [...staticModules, ...agentModules(context), ...customAgentModules(context), ...customerModules(context)];
  const seen = new Set<string>();
  return result.filter((module) => {
    if (seen.has(module.id)) return false;
    seen.add(module.id);
    return true;
  });
}
