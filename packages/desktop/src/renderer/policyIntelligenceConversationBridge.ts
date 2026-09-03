/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type {
  PolicyAction,
  PolicyDiagnosis,
  PolicyEnterpriseProfile,
  PolicyIntelligenceState,
} from '../preload/index.js';
import {
  parsePolicyAnswer,
  policyDisplayStatus,
  POLICY_LEVEL_LABELS,
  POLICY_STATUS_LABELS,
} from './policyIntelligencePresentation.js';

interface PendingPolicyConversation {
  scopeId: string;
  sessionId: string;
  expiresAt: number;
  phase:
    'browse' | 'consent' | 'enable' | 'profile' | 'profile-confirm' | 'answer';
  policyIds?: string[];
  policyId?: string;
  diagnosisId?: string;
  fields?: string[];
  patch?: PolicyEnterpriseProfile;
}
export class PolicyConversationRegistry {
  private readonly pending = new Map<string, PendingPolicyConversation>();
  private key(scopeId: string, sessionId: string): string {
    return JSON.stringify([scopeId, sessionId]);
  }
  get(
    scopeId: string,
    sessionId: string,
  ): PendingPolicyConversation | undefined {
    const key = this.key(scopeId, sessionId);
    const value = this.pending.get(key);
    if (value && value.expiresAt < Date.now()) {
      this.pending.delete(key);
      return undefined;
    }
    return value;
  }
  set(value: PendingPolicyConversation): void {
    for (const [key, entry] of this.pending)
      if (entry.expiresAt < Date.now()) this.pending.delete(key);
    if (this.pending.size >= 100)
      this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(this.key(value.scopeId, value.sessionId), value);
  }
  clear(scopeId: string, sessionId: string): void {
    this.pending.delete(this.key(scopeId, sessionId));
  }
}
const FIELD_LABELS: Record<string, string> = {
  registeredRegion: '企业注册所在地（请写明省、市、区县）',
  industry: '所属行业',
  mainBusiness: '主营业务',
  enterpriseType: '登记类型',
  establishedAt: '成立日期（YYYY-MM-DD）',
  qualifications: '已有资质，没有请写“暂无”',
};
function diagnosisText(diagnosis: PolicyDiagnosis): string {
  return [
    diagnosis.summary,
    ...(diagnosis.exclusions ?? []).map(
      (item) =>
        `· 排除核验：${{ hit: '已命中', clear: '未命中／例外已满足', unknown: '待核实' }[item.result]} · ${item.label}\n  原文：${item.quote}${item.scopeConditionIds?.length ? '\n  仅影响指定申报路径，不作全局否决。' : ''}`,
    ),
    ...(diagnosis.warnings ?? []).map((warning) => `提醒：${warning}`),
    ...diagnosis.conditions.map(
      (item) =>
        '· ' +
        { met: '已有资料支持', gap: '有差距', unknown: '待确认' }[item.result] +
        '：' +
        item.label +
        '\n  原文：' +
        item.quote +
        '\n  企业资料：' +
        item.evidence,
    ),
    ...(diagnosis.supportEstimate
      ? [
          `支持估算：${diagnosis.supportEstimate.amountCny === undefined ? '' : `${diagnosis.supportEstimate.amountCny} 元。`}${diagnosis.supportEstimate.explanation}`,
        ]
      : []),
    diagnosis.question
      ? '\n' + diagnosis.question.label
      : '\n本次已知信息已核对完毕。未确定的信息仍保持待确认，可以在右侧模块回看。',
    '\n本次回答默认仅当前账号保存；不会代为提交申请。结论以主管部门审核为准。',
  ].join('\n');
}
export async function handlePolicyIntelligenceConversation(input: {
  text: string;
  scopeId: string;
  sessionId: string;
  registry: PolicyConversationRegistry;
  getState(): Promise<PolicyIntelligenceState>;
  act(action: PolicyAction): Promise<PolicyIntelligenceState>;
  postMessage(role: 'user' | 'assistant', text: string): void;
}): Promise<boolean> {
  const text = input.text.trim();
  const pending = input.registry.get(input.scopeId, input.sessionId);
  const clear = (): void =>
    input.registry.clear(input.scopeId, input.sessionId);
  const say = (message: string): void =>
    input.postMessage('assistant', message);
  const remember = (
    value: Omit<
      PendingPolicyConversation,
      'scopeId' | 'sessionId' | 'expiresAt'
    >,
  ): void =>
    input.registry.set({
      ...value,
      scopeId: input.scopeId,
      sessionId: input.sessionId,
      expiresAt: Date.now() + 30 * 60_000,
    });
  const intent = /政策|申报项目|可申报|能申报|补贴|补助|资质认定/u.test(text);
  if (pending && /^(?:取消|不保存|结束政策诊断|停止)$/u.test(text)) {
    clear();
    say('已停止本次政策问答，尚未确认的共享资料没有保存。');
    return true;
  }
  if (pending && /^(?:帮我写|写一|生成代码|我要报修|我要拼车)/u.test(text)) {
    clear();
    return false;
  }
  if (!intent && !pending) return false;
  if (
    pending?.phase === 'browse' &&
    !intent &&
    !/诊断|评估|第?\s*\d+\s*[项条]/u.test(text)
  )
    return false;
  try {
    if (pending?.phase === 'enable') {
      if (text !== '同意开启') {
        say(
          '回复“同意开启”才会启用企业资料分析并产生模型调用，回复“取消”放弃。',
        );
        return true;
      }
      await input.act({ action: 'configure', enabled: true, consent: true });
      clear();
      say('已开启企业政策服务。可说“完善政策企业资料”或“有哪些政策”。');
      return true;
    }
    if (pending?.phase === 'profile-confirm') {
      if (text !== '确认保存') {
        say('这些资料将成为企业共享资料。回复“确认保存”或“取消”。');
        return true;
      }
      await input.act({
        action: 'profile',
        profile: pending.patch,
        consent: true,
      });
      clear();
      say('已保存为企业共享资料。你可以说“更新企业政策推荐”。');
      return true;
    }
    if (pending?.phase === 'profile') {
      const [field, ...remaining] = pending.fields ?? [];
      if (!field) {
        clear();
        return false;
      }
      const patch = {
        ...pending.patch,
        [field]: parsePolicyAnswer(field, text),
      };
      if (patch[field] === null) {
        say(
          '基础资料可以暂不提供。请回复明确资料，或回复“取消”先浏览公共政策。',
        );
        return true;
      }
      if (remaining.length) {
        remember({ ...pending, patch, fields: remaining });
        say('请补充' + (FIELD_LABELS[remaining[0]] ?? remaining[0]) + '。');
      } else {
        remember({ phase: 'profile-confirm', patch });
        say(
          '拟保存的企业资料：\n' +
            Object.entries(patch)
              .map(
                ([key, value]) =>
                  (FIELD_LABELS[key] ?? key) +
                  '：' +
                  (Array.isArray(value) ? value.join('、') : String(value)),
              )
              .join('\n') +
            '\n\n回复“确认保存”才写入企业共享资料，回复“取消”放弃。',
        );
      }
      return true;
    }
    if (pending?.phase === 'consent') {
      if (text !== '同意诊断') {
        say(
          '回复“同意诊断”，已配置模型才会读取企业资料并开始分析；本次补充回答默认仅当前账号保存。也可以回复“取消”。',
        );
        return true;
      }
      const state = await input.act({
        action: 'diagnose',
        policyId: pending.policyId,
        consent: true,
      });
      const diagnosis = state.diagnoses.find(
        (item) => item.policyId === pending.policyId && !item.stale,
      );
      if (!diagnosis) {
        clear();
        say('暂未生成可用诊断，请在模块中查看原因。');
        return true;
      }
      if (diagnosis.question)
        remember({ phase: 'answer', diagnosisId: diagnosis.id });
      else clear();
      say(diagnosisText(diagnosis));
      return true;
    }
    if (pending?.phase === 'answer') {
      const current = await input.getState();
      const diagnosis = current.diagnoses.find(
        (item) => item.id === pending.diagnosisId,
      );
      if (!diagnosis || diagnosis.stale || !diagnosis.question) {
        clear();
        say('该诊断已更新或结束，请重新选择政策诊断。');
        return true;
      }
      const state = await input.act({
        action: 'answer',
        diagnosisId: diagnosis.id,
        revision: diagnosis.revision,
        field: diagnosis.question.field,
        value: parsePolicyAnswer(
          diagnosis.question.field,
          text,
          diagnosis.question.valueType,
        ),
      });
      const next = state.diagnoses.find((item) => item.id === diagnosis.id);
      if (next) {
        if (!next.question) clear();
        say(diagnosisText(next));
      } else clear();
      return true;
    }
    let state = await input.getState();
    if (/开启.*政策|政策.*开启/u.test(text)) {
      remember({ phase: 'enable' });
      say(
        '企业个性化政策服务会使用基础企业资料调用已配置模型，消耗 API 额度。可以随时关闭。回复“同意开启”确认。',
      );
      return true;
    }
    if (/关闭.*政策|政策.*关闭/u.test(text)) {
      await input.act({ action: 'configure', enabled: false });
      clear();
      say('已关闭个性化分析。公共政策和已有诊断仍可查看。');
      return true;
    }
    if (/完善.*资料|补充.*企业资料/u.test(text)) {
      const fields = state.missingProfileFields.length
        ? state.missingProfileFields
        : ['registeredRegion', 'industry', 'mainBusiness'];
      remember({ phase: 'profile', fields, patch: {} });
      say(
        '请补充' +
          (FIELD_LABELS[fields[0]] ?? fields[0]) +
          '。我会逐项询问，最后确认后才共享保存。',
      );
      return true;
    }
    const chosen = text.match(/(?:诊断|评估)\s*第?\s*(\d+)\s*[项条]?/u);
    const byTitle = state.policies.find(
      (doc) => text.includes(doc.title) && /诊断|能否|能不能|符合/u.test(text),
    );
    if (chosen || byTitle) {
      const id = byTitle?.id ?? pending?.policyIds?.[Number(chosen?.[1]) - 1];
      if (!id) {
        say('请先说“有哪些政策”，再按列表回复“诊断第1项”。');
        return true;
      }
      if (!state.enabled) {
        say('请先在右侧模块开启服务，或说“开启政策服务”。');
        return true;
      }
      remember({ phase: 'consent', policyId: id });
      say(
        '将使用已配置模型核验这项政策和企业资料；本次回答默认私有，不自动共享、不提交申请。回复“同意诊断”开始，或“取消”。',
      );
      return true;
    }
    if (/更新.*政策.*推荐|重新.*政策.*评估/u.test(text))
      state = await input.act({ action: 'sync' });
    const recommended = state.assessments
      .filter((item) => item.group !== 'all')
      .map((item) => item.policyId);
    const docs = [...state.policies]
      .sort(
        (a, b) =>
          Number(recommended.includes(b.id)) -
          Number(recommended.includes(a.id)),
      )
      .slice(0, 8);
    remember({ phase: 'browse', policyIds: docs.map((doc) => doc.id) });
    const region = [
      state.region.province !== state.region.city ? state.region.province : '',
      state.region.city,
      state.region.district,
    ]
      .filter(Boolean)
      .join('');
    say(
      (region
        ? '当前按 ' + region + ' 及上级政策范围展示：\n\n'
        : '企业所在地尚未补齐，目前先展示国家级已收录政策：\n\n') +
        (docs.length
          ? docs
              .map(
                (doc, index) =>
                  index +
                  1 +
                  '. ' +
                  doc.title +
                  '｜' +
                  POLICY_LEVEL_LABELS[doc.level] +
                  '｜' +
                  POLICY_STATUS_LABELS[policyDisplayStatus(doc)] +
                  '\n   官方原文：' +
                  doc.url,
              )
              .join('\n\n')
          : '暂未收录可展示政策。未收录不代表没有可申报项目，请检查来源覆盖。') +
        '\n\n可回复“诊断第1项”逐项核验，或说“完善政策企业资料”。浏览不会发起模型分析。',
    );
    return true;
  } catch (error) {
    say(
      error instanceof Error
        ? error.message
        : '政策服务暂时不可用，请稍后重试。',
    );
    return true;
  }
}
