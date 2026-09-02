/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type {
  PolicyEnterpriseProfile,
  PolicyIntelligenceState,
} from '../preload/index.js';

interface PendingPolicyProfile {
  scopeId: string;
  sessionId: string;
  phase: 'collecting' | 'confirming';
  patch: PolicyEnterpriseProfile;
}

export class PolicyConversationRegistry {
  private readonly pending = new Map<string, PendingPolicyProfile>();
  private key(scopeId: string, sessionId: string): string { return `${scopeId}:${sessionId}`; }
  get(scopeId: string, sessionId: string): PendingPolicyProfile | undefined {
    return this.pending.get(this.key(scopeId, sessionId));
  }
  set(value: PendingPolicyProfile): void { this.pending.set(this.key(value.scopeId, value.sessionId), value); }
  clear(scopeId: string, sessionId: string): void { this.pending.delete(this.key(scopeId, sessionId)); }
}

const POLICY_INTENT = /(?:政策|申报|补贴|补助|扶持|奖励|资质).{0,20}(?:什么|哪些|最近|能否|能不能|可以|条件|门槛|差什么|缺什么|原文|项目)|(?:我们|公司|企业).{0,12}(?:能申报|可申报)/u;

function parseProfilePatch(text: string): PolicyEnterpriseProfile {
  const patch: PolicyEnterpriseProfile = {};
  const region = text.match(/(?:注册(?:地|地址)?(?:在|是)?|位于|公司在)?\s*(北京(?:市)?(?:昌平|朝阳|海淀|顺义|大兴|通州|丰台|石景山|门头沟|房山|怀柔|密云|延庆|东城|西城)(?:区)?)/u)?.[1];
  if (region) {
    const district = region.replace(/^北京市?/u, '').replace(/区$/u, '');
    patch.registeredRegion = district ? `北京市${district}区` : '北京市';
  }
  const industry = text.match(/(?:主营(?:业务|行业)?|所属行业|行业)(?:是|为|：|:)?\s*([^，。；;\n]{2,30})/u)?.[1]?.trim();
  if (industry) patch.industry = industry;
  const employees = text.match(/(?:员工|人员)(?:约|大约|共|有)?\s*(\d{1,7})\s*人/u)?.[1];
  if (employees) patch.employeeCount = Number(employees);
  const establishedAt = text.match(/(?:成立于|成立时间(?:是|为|：|:)?)[\s]*(20\d{2}[年./-]\d{1,2}(?:[月./-]\d{1,2}日?)?)/u)?.[1];
  if (establishedAt) patch.establishedAt = establishedAt;
  const qualification = text.match(/(?:资质|认证)(?:有|包括|是|为|：|:)?\s*([^。；;\n]{2,100})/u)?.[1]?.trim();
  if (qualification) patch.qualifications = qualification.split(/[、，,]/u).map((item) => item.trim()).filter(Boolean);
  const products = text.match(/(?:产品与服务|产品|服务)(?:包括|有|是|为|：|:)?\s*([^。；;\n]{2,160})/u)?.[1]?.trim();
  if (products) patch.productsServices = products.split(/[、，,]/u).map((item) => item.trim()).filter(Boolean);
  const capabilities = text.match(/(?:企业能力|核心能力|技术能力)(?:包括|有|是|为|：|:)?\s*([^。；;\n]{2,160})/u)?.[1]?.trim();
  if (capabilities) patch.capabilities = capabilities.split(/[、，,]/u).map((item) => item.trim()).filter(Boolean);
  const money = (pattern: RegExp): number | undefined => {
    const match = text.match(pattern);
    if (!match) return undefined;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount < 0) return undefined;
    const multiplier = match[2] === '亿' ? 100_000_000 : match[2] === '万' ? 10_000 : 1;
    return Math.round(amount * multiplier);
  };
  const annualRevenueCny = money(/(?:年营业收入|年度营业收入|年营收|营业收入)(?:约|大约|是|为|：|:)?\s*(\d+(?:\.\d+)?)\s*(亿|万)?元?/u);
  if (annualRevenueCny !== undefined) patch.annualRevenueCny = annualRevenueCny;
  const rdExpenseCny = money(/(?:研发费用|研发投入|研发支出)(?:约|大约|是|为|：|:)?\s*(\d+(?:\.\d+)?)\s*(亿|万)?元?/u);
  if (rdExpenseCny !== undefined) patch.rdExpenseCny = rdExpenseCny;
  return patch;
}

function missingCore(profile: PolicyEnterpriseProfile): string[] {
  return [
    ...(!profile.registeredRegion?.trim() ? ['注册地区'] : []),
    ...(!profile.industry?.trim() ? ['主营行业'] : []),
  ];
}

function describePatch(patch: PolicyEnterpriseProfile): string {
  return [
    patch.registeredRegion ? `注册地区：${patch.registeredRegion}` : '',
    patch.industry ? `主营行业：${patch.industry}` : '',
    patch.employeeCount !== undefined ? `员工人数：${patch.employeeCount} 人` : '',
    patch.annualRevenueCny !== undefined ? `年营业收入：${patch.annualRevenueCny.toLocaleString('zh-CN')} 元` : '',
    patch.rdExpenseCny !== undefined ? `研发费用：${patch.rdExpenseCny.toLocaleString('zh-CN')} 元` : '',
    patch.establishedAt ? `成立时间：${patch.establishedAt}` : '',
    patch.qualifications?.length ? `已有资质：${patch.qualifications.join('、')}` : '',
    patch.productsServices?.length ? `产品与服务：${patch.productsServices.join('、')}` : '',
    patch.capabilities?.length ? `企业能力：${patch.capabilities.join('、')}` : '',
  ].filter(Boolean).join('\n');
}

const PROFILE_FIELD_LABELS: Readonly<Record<string, string>> = {
  organizationName: '企业名称', registeredRegion: '注册地区', industry: '主营行业',
  establishedAt: '成立时间', employeeCount: '员工人数', annualRevenueCny: '年营业收入',
  rdExpenseCny: '研发费用', qualifications: '已有资质', productsServices: '产品与服务',
  capabilities: '企业能力', notes: '其他申报材料',
};

function assessmentMissingFields(state: PolicyIntelligenceState): string[] {
  return [...new Set(state.assessments.flatMap((item) => item.missingFields))].slice(0, 8);
}

function missingFieldPrompt(fields: readonly string[]): string {
  return fields.map((field) => PROFILE_FIELD_LABELS[field] ?? field).join('、');
}

function formatPolicyResults(state: PolicyIntelligenceState): string {
  const documentById = new Map(state.policies.map((item) => [item.id, item]));
  const ranked = [...state.assessments]
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
  if (!ranked.length) {
    return state.syncStatus === 'error'
      ? `政策同步暂时失败：${state.lastError ?? '未知错误'}。你可以稍后让我重新同步。`
      : '暂时还没有完成政策分析。你可以说“立即同步政策”后再试。';
  }
  const labels: Record<string, string> = {
    likely_eligible: '初步符合', has_gaps: '存在缺口', unlikely: '初步不符合', unknown: '资料不足',
  };
  const lines = ranked.flatMap((assessment, index) => {
    const document = documentById.get(assessment.policyId);
    if (!document) return [];
    const gaps = assessment.gaps.length ? `\n   缺口：${assessment.gaps.join('；')}` : '';
    const missing = assessment.missingFields.length ? `\n   待补资料：${assessment.missingFields.join('、')}` : '';
    const resources = assessment.resourceConnections.length ? `\n   对接：${assessment.resourceConnections.join('；')}` : '';
    return [`${index + 1}. ${document.title}｜${labels[assessment.status] ?? assessment.status}｜匹配分 ${assessment.score}\n   ${assessment.summary}${gaps}${missing}${resources}\n   官方原文：${document.url}`];
  });
  return `${lines.join('\n\n')}\n\n以上是 Otto 基于官方原文和现有企业资料生成的辅助判断，不代表主管部门审核结论。`;
}

export async function handlePolicyIntelligenceConversation(input: {
  text: string;
  scopeId: string;
  sessionId: string;
  registry: PolicyConversationRegistry;
  getState(): Promise<PolicyIntelligenceState>;
  sync(): Promise<PolicyIntelligenceState>;
  updateProfile(patch: PolicyEnterpriseProfile): Promise<PolicyIntelligenceState>;
  postMessage(role: 'user' | 'assistant', text: string): void;
}): Promise<boolean> {
  const text = input.text.trim();
  const pending = input.registry.get(input.scopeId, input.sessionId);
  if (pending?.phase === 'confirming') {
    if (/^(?:确认保存(?:并重新评估)?|确认)$/u.test(text)) {
      await input.updateProfile(pending.patch);
      input.registry.clear(input.scopeId, input.sessionId);
      input.postMessage('assistant', `企业资料已更新：\n${describePatch(pending.patch)}\n正在按新资料重新评估政策。`);
      const state = await input.sync();
      const remaining = assessmentMissingFields(state);
      if (remaining.length) {
        input.registry.set({ scopeId: input.scopeId, sessionId: input.sessionId, phase: 'collecting', patch: {} });
      }
      input.postMessage('assistant', `${formatPolicyResults(state)}${remaining.length ? `\n\n为了继续判断，请补充：${missingFieldPrompt(remaining)}。我仍会先展示识别结果，确认后才保存。` : ''}`);
      return true;
    }
    if (/^(?:取消|不保存|放弃)$/u.test(text)) {
      input.registry.clear(input.scopeId, input.sessionId);
      input.postMessage('assistant', '已取消，本次补充资料没有保存。');
      return true;
    }
  }
  if (pending?.phase === 'collecting') {
    const patch = parseProfilePatch(text);
    if (Object.keys(patch).length === 0) {
      input.postMessage('assistant', '我还没识别到可保存的企业资料。请例如回复：“注册在北京昌平，主营企业软件，员工 20 人”。');
      return true;
    }
    input.registry.set({ ...pending, phase: 'confirming', patch });
    input.postMessage('assistant', `我识别到以下企业资料：\n${describePatch(patch)}\n\n回复“确认保存并重新评估”后才会写入；回复“取消”则放弃。`);
    return true;
  }
  if (!POLICY_INTENT.test(text) && !/(?:立即|重新|手动)同步政策/u.test(text)) return false;
  let state = await input.getState();
  if (!state.enabled) {
    input.postMessage('assistant', '政策智能服务当前未开启。请在右侧“政策智能服务”模块中主动开启；关闭状态不会抓取网站，也不会调用模型或消耗 Token。');
    return true;
  }
  const missing = missingCore(state.profile);
  if (missing.length) {
    input.registry.set({ scopeId: input.scopeId, sessionId: input.sessionId, phase: 'collecting', patch: {} });
    input.postMessage('assistant', `要判断可申报项目，我还缺少：${missing.join('、')}。请例如回复：“注册在北京昌平，主营企业软件”。我会先展示识别结果，经你确认后再保存和重新评估。`);
    return true;
  }
  if (/(?:立即|重新|手动)同步政策/u.test(text) || state.policies.length === 0) state = await input.sync();
  const assessmentMissing = assessmentMissingFields(state);
  if (assessmentMissing.length) {
    input.registry.set({ scopeId: input.scopeId, sessionId: input.sessionId, phase: 'collecting', patch: {} });
  }
  input.postMessage('assistant', `${formatPolicyResults(state)}${assessmentMissing.length ? `\n\n为了继续判断，请补充：${missingFieldPrompt(assessmentMissing)}。我会先展示识别结果，经你确认后再保存和重新评估。` : ''}`);
  return true;
}
