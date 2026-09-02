/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type { ModuleDefinition, ParkModuleTarget, RecruitmentModuleTarget } from './moduleCatalog.js';

const PARK_PROMPTS: Readonly<Record<ParkModuleTarget, string>> = {
  overview: '查一下园区服务统计',
  announcement: '看看最新园区公告',
  satisfaction: '填写满意度调查',
  renovation: '提交装修申请',
  parking: '申请停车位',
  'network-phone': '申请开通企业专线',
  'meeting-room': '预约会议室',
  'electric-card': '办理电卡充值',
  repair: '我要物业报修',
  'vehicle-visit': '登记访客',
  'enterprise-star-map': '看看企业星链图',
  'staff-tasks': '查一下园区待办',
  'my-applications': '查一下我的申请',
};

const RECRUITMENT_PROMPTS: Readonly<Record<RecruitmentModuleTarget, string>> = {
  'resume-analysis': '分析一份简历',
  'candidate-screening': '查看人员初步分析',
  'interview-audio': '分析面试录音',
  'interview-kit': '生成面试材料',
  'privacy-audit': '查看招聘隐私与审计',
};

export function moduleConversationPrompt(module: ModuleDefinition): string | null {
  if (module.availability !== 'available') return null;
  const activation = module.activation;
  if (activation.kind === 'agent') return `让 ${module.label}帮我处理这项任务`;
  if (activation.kind === 'customer-module') return `使用${module.label}`;
  if (activation.kind === 'route') return '打开 Skill 专区';
  if (activation.dialog === 'park') return PARK_PROMPTS[activation.target];
  if (activation.dialog === 'recruitment') return RECRUITMENT_PROMPTS[activation.target];
  if (activation.dialog === 'enterprise-memory') return '查一下企业记忆';
  if (activation.dialog === 'auto-skill') return '查看自动 Skill 候选';
  return null;
}

export function preferredModuleConversationPrompt(
  modules: readonly ModuleDefinition[],
): string | null {
  const available = modules.filter((module) => module.availability === 'available');
  const preferred = available.find((module) => module.id === 'park-repair')
    ?? available.find((module) => module.activation.kind === 'customer-module')
    ?? available.find((module) => module.activation.kind === 'agent')
    ?? available[0];
  return preferred ? moduleConversationPrompt(preferred) : null;
}
