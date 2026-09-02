/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { handleParkQueryConversation } from './parkModuleConversationBridge.js';
import {
  ParkServiceActionDraftRegistry,
  handleParkServiceActionConversation,
  type ParkTicketActionDraft,
} from './parkServiceActionBridge.js';
import {
  CustomerModuleConversationDraftRegistry,
  handleCustomerModuleConversation,
  type CustomerModuleConversationDraft,
} from './customerModuleConversationBridge.js';
import {
  RecruitmentConversationDraftRegistry,
  type RecruitmentConversationDraft,
} from './recruitmentConversationBridge.js';

describe('通用模块对话桥压力与边界', () => {
  it('公告查询限制为最新5条，单条超长正文会截断', async () => {
    const messages: string[] = [];
    await handleParkQueryConversation({
      text: '查看最新园区公告', enabled: true,
      postMessage: (_role, text) => messages.push(text),
      listPublications: async () => Array.from({ length: 100 }, (_, index) => ({
        id: String(index), kind: 'announcement' as const, title: `公告${index}`,
        body: 'x'.repeat(20_000), createdAt: new Date(index * 1_000).toISOString(),
        readAt: null, submittedAt: null,
      })),
      loadStatistics: vi.fn(), loadStarMap: vi.fn(), listMyApplications: vi.fn(), listStaffTasks: vi.fn(),
    });
    const output = messages.at(-1) ?? '';
    expect((output.match(/\*\*公告/gu) ?? [])).toHaveLength(5);
    expect(output.length).toBeLessThan(4_000);
  });

  it('同一园区申请200次并发确认只创建一个工单', async () => {
    const registry = new ParkServiceActionDraftRegistry();
    const defaults = { company: '企业', roomNumber: '101', contact: '张三', phone: '13800138000' };
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const submitTicket = vi.fn(async () => {
      await barrier;
      return { id: 't1', status: '待接单', recipients: [], recipientCount: 1 };
    });
    const common = {
      sessionId: 's1', accountId: 'a1', enabled: true, registry,
      loadDefaults: async () => defaults,
      loadMeetingResources: vi.fn(), listPublications: vi.fn(), submitTicket, submitSurvey: vi.fn(),
      postMessage: vi.fn(), now: () => 1_000,
    };
    await handleParkServiceActionConversation({ ...common, text: '办理电卡充电100度' });
    const attempts = Array.from({ length: 200 }, () => (
      handleParkServiceActionConversation({ ...common, text: '确认提交' })
    ));
    await Promise.resolve();
    await Promise.resolve();
    expect(submitTicket).toHaveBeenCalledTimes(1);
    release?.();
    await Promise.all(attempts);
  }, 10_000);

  it('同一客户模块200次并发确认只启动一次运行', async () => {
    const registry = new CustomerModuleConversationDraftRegistry();
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const runModule = vi.fn(async () => {
      await barrier;
      return { result: { status: 'completed' as const, exitCode: 0, output: 'ok' }, audit: [], hostAudit: [] };
    });
    const common = {
      sessionId: 's1', accountId: 'a1', enabled: true, registry, runModule, postMessage: vi.fn(), now: () => 1_000,
      modules: [{
        id: 'm1', version: '1', name: '批处理模块', description: '', enabled: true,
        inputSchema: { type: 'object' as const, properties: { input: { type: 'string', title: '输入' } }, required: ['input'] },
        permissions: [],
      }],
    };
    await handleCustomerModuleConversation({ ...common, text: '运行批处理模块，输入：测试' });
    const attempts = Array.from({ length: 200 }, () => (
      handleCustomerModuleConversation({ ...common, text: '确认运行' })
    ));
    await Promise.resolve();
    await Promise.resolve();
    expect(runModule).toHaveBeenCalledTimes(1);
    release?.();
    await Promise.all(attempts);
  }, 10_000);

  it('三个草稿注册表在大量废弃会话下保持硬容量上限', () => {
    const started = performance.now();
    const park = new ParkServiceActionDraftRegistry();
    for (let index = 0; index < 12_000; index += 1) {
      park.save({
        id: `p${index}`, kind: 'ticket', serviceId: 'electric-card', idempotencyKey: `park:${index}`,
        sessionId: `s${index}`, accountId: 'a', createdAt: index, updatedAt: index,
        expiresAt: 100_000, phase: 'collecting', fields: {},
      } satisfies ParkTicketActionDraft);
    }
    expect(park.get('s0', 'a', 20_000)).toBeNull();
    expect(park.get('s11999', 'a', 20_000)).toBeTruthy();

    const customer = new CustomerModuleConversationDraftRegistry();
    for (let index = 0; index < 6_000; index += 1) {
      customer.save({
        id: `c${index}`, moduleId: 'm', version: '1', moduleName: 'M',
        sessionId: `s${index}`, accountId: 'a', createdAt: index, updatedAt: index,
        expiresAt: 100_000, phase: 'collecting', inputSchema: { type: 'object', properties: {} },
        permissions: [], values: {},
      } satisfies CustomerModuleConversationDraft);
    }
    expect(customer.get('s0', 'a', 20_000)).toBeNull();
    expect(customer.get('s5999', 'a', 20_000)).toBeTruthy();

    const recruitment = new RecruitmentConversationDraftRegistry();
    for (let index = 0; index < 1_500; index += 1) {
      recruitment.save({
        id: `r${index}`, kind: 'resume-import', sessionId: `s${index}`, accountId: 'a',
        createdAt: index, updatedAt: index, expiresAt: 100_000,
      } satisfies RecruitmentConversationDraft);
    }
    expect(recruitment.get('s0', 'a', 20_000)).toBeNull();
    expect(recruitment.get('s1499', 'a', 20_000)).toBeTruthy();
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it('1000条随机反向文本不会抛异常或触发写接口', async () => {
    const submitTicket = vi.fn();
    const registry = new ParkServiceActionDraftRegistry();
    const alphabet = ['公告', '确认提交', '<script>', 'DROP TABLE', '会议室', '不要申请', '天气', '\\u0000'];
    for (let index = 0; index < 1_000; index += 1) {
      const text = `${alphabet[index % alphabet.length]}-${index}-${'x'.repeat(index % 80)}`;
      await expect(handleParkServiceActionConversation({
        text, sessionId: `s${index}`, accountId: 'a', enabled: true, registry,
        loadDefaults: async () => ({ company: '企业', roomNumber: '1', contact: '人', phone: '13800138000' }),
        loadMeetingResources: vi.fn(), listPublications: vi.fn(), submitTicket, submitSurvey: vi.fn(),
        postMessage: vi.fn(), now: () => 1_000,
      })).resolves.toBeTypeOf('boolean');
    }
    expect(submitTicket).not.toHaveBeenCalled();
  }, 10_000);
});
