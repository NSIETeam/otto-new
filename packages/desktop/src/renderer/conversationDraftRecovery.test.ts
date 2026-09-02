/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it } from 'vitest';
import { ModuleActionDraftRegistry, prepareModuleAction } from './moduleActionBridge.js';
import { ParkServiceActionDraftRegistry, type ParkServiceActionDraft } from './parkServiceActionBridge.js';
import {
  CustomerModuleConversationDraftRegistry,
  type CustomerModuleConversationDraft,
} from './customerModuleConversationBridge.js';
import {
  RecruitmentConversationDraftRegistry,
  type RecruitmentConversationDraft,
} from './recruitmentConversationBridge.js';
import { WorkspaceCapabilityDraftRegistry } from './workspaceCapabilityConversationBridge.js';

const NOW = 1_000;
const EXPIRES = 60_000;

describe('统一动作草稿重启恢复', () => {
  it('恢复五类未过期草稿，并拒绝其他账号与过期数据', () => {
    const repairSource = new ModuleActionDraftRegistry();
    const prepared = prepareModuleAction({
      text: '我要报修，会议室顶灯不亮，普通',
      sessionId: 'session-repair',
      accountId: 'account-a',
      defaults: { company: '序动科技', roomNumber: 'A1203', contact: '张三', phone: '13800138000' },
      now: NOW,
    });
    repairSource.save(prepared!.draft!);
    const repairTarget = new ModuleActionDraftRegistry();
    expect(repairTarget.restore('account-a', repairSource.snapshot('account-a', NOW), NOW)).toBe(1);
    expect(repairTarget.summary('session-repair', 'account-a', NOW)?.confirmationText).toBe('确认提交');

    const parkDraft: ParkServiceActionDraft = {
      id: 'park-1', kind: 'ticket', serviceId: 'parking', idempotencyKey: 'idem-1',
      sessionId: 'session-park', accountId: 'account-a', createdAt: NOW, updatedAt: NOW,
      expiresAt: EXPIRES, phase: 'awaiting_confirmation',
      fields: {
        company: '序动科技', roomNumber: 'A1203', contact: '张三', phone: '13800138000',
        request: '地下固定停车位', quantity: '1',
      },
    };
    const parkTarget = new ParkServiceActionDraftRegistry();
    expect(parkTarget.restore('account-a', [parkDraft], NOW)).toBe(1);
    expect(parkTarget.summary('session-park', 'account-a', NOW)?.source).toBe('park-service');

    const customerDraft: CustomerModuleConversationDraft = {
      id: 'customer-1', moduleId: 'summary', version: '1', moduleName: '文本摘要',
      sessionId: 'session-customer', accountId: 'account-a', createdAt: NOW, updatedAt: NOW,
      expiresAt: EXPIRES, phase: 'awaiting_confirmation',
      inputSchema: { type: 'object', properties: { text: { type: 'string', title: '原文' } }, required: ['text'] },
      permissions: [], values: { text: '需要摘要的正文' },
    };
    const customerTarget = new CustomerModuleConversationDraftRegistry();
    expect(customerTarget.restore('account-a', [customerDraft], NOW)).toBe(1);
    expect(customerTarget.summary('session-customer', 'account-a', NOW)?.source).toBe('customer-module');

    const recruitmentDraft: RecruitmentConversationDraft = {
      id: 'recruitment-1', kind: 'audio-import', sessionId: 'session-recruitment',
      accountId: 'account-a', candidateId: 'candidate-1', createdAt: NOW, updatedAt: NOW, expiresAt: EXPIRES,
    };
    const recruitmentTarget = new RecruitmentConversationDraftRegistry();
    expect(recruitmentTarget.restore('account-a', [recruitmentDraft], NOW)).toBe(1);
    expect(recruitmentTarget.get('session-recruitment', 'account-a', NOW)?.id).toBe('recruitment-1');

    const workspaceSource = new WorkspaceCapabilityDraftRegistry(() => NOW);
    workspaceSource.set('account-a', 'session-knowledge', {
      kind: 'knowledge', sourceId: 'knowledge-1', title: '出差制度', category: '制度',
      content: '出差前必须申请。', phase: 'ready',
    });
    const workspaceTarget = new WorkspaceCapabilityDraftRegistry(() => NOW);
    expect(workspaceTarget.restore('account-a', workspaceSource.snapshot('account-a'))).toBe(1);
    expect(workspaceTarget.summary('account-a', 'session-knowledge')?.source).toBe('enterprise-knowledge');

    expect(repairTarget.restore('account-a', [{ ...prepared!.draft, accountId: 'account-b' }], NOW)).toBe(0);
    expect(parkTarget.restore('account-a', [{ ...parkDraft, expiresAt: NOW }], NOW)).toBe(0);
  });
});
