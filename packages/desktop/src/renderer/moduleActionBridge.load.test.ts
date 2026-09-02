/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_MODULE_ACTION_DRAFTS,
  ModuleActionDraftRegistry,
  handleModuleActionConversation,
  prepareModuleAction,
  type ModuleActionDraft,
} from './moduleActionBridge.js';

const defaults = {
  company: '压力测试企业',
  roomNumber: 'A座1203室',
  contact: '测试人员',
  phone: '13800138000',
};

function completeDraft(index: number): ModuleActionDraft {
  const transition = prepareModuleAction({
    text: `我要物业报修，第${index}会议室灯坏了，普通`,
    sessionId: `session-${index}`,
    accountId: 'load-account',
    defaults,
    now: index + 1,
  });
  if (!transition?.draft) throw new Error('expected load-test draft');
  return transition.draft;
}

describe('物业报修对话桥：压力与并发', () => {
  it('大量废弃草稿受容量上限约束，并可一次清理过期数据', () => {
    const registry = new ModuleActionDraftRegistry();
    const started = performance.now();
    for (let index = 0; index < MAX_MODULE_ACTION_DRAFTS + 2_000; index += 1) {
      registry.save(completeDraft(index));
    }
    const elapsed = performance.now() - started;

    expect(registry.activeDraftCount(MAX_MODULE_ACTION_DRAFTS + 2_001)).toBe(
      MAX_MODULE_ACTION_DRAFTS,
    );
    expect(registry.get('session-0', 'load-account', 2_000)).toBeNull();
    expect(registry.get(
      `session-${MAX_MODULE_ACTION_DRAFTS + 1_999}`,
      'load-account',
      MAX_MODULE_ACTION_DRAFTS + 2_001,
    )).toBeTruthy();
    expect(elapsed).toBeLessThan(5_000);

    expect(registry.activeDraftCount(Number.MAX_SAFE_INTEGER)).toBe(0);
  }, 10_000);

  it('500 个会话并发确认时各提交一次且互不串号', async () => {
    const registry = new ModuleActionDraftRegistry();
    const submitted = new Set<string>();
    const submit = vi.fn(async (input) => {
      submitted.add(input.formData.issue);
      return {
        id: `ticket-${submitted.size}`,
        applicationNumber: `BX-${submitted.size}`,
        status: '待接单',
        recipients: [],
        recipientCount: 1,
      };
    });
    for (let index = 0; index < 500; index += 1) registry.save(completeDraft(index));

    await Promise.all(Array.from({ length: 500 }, (_, index) =>
      handleModuleActionConversation({
        text: '确认提交',
        sessionId: `session-${index}`,
        accountId: 'load-account',
        enabled: true,
        registry,
        loadDefaults: async () => defaults,
        submit,
        postMessage: () => {},
        now: () => 1_000,
      })));

    expect(submit).toHaveBeenCalledTimes(500);
    expect(submitted).toHaveLength(500);
    expect(registry.activeDraftCount(1_000)).toBe(0);
  }, 10_000);

  it('同一会话 200 次并发确认只产生一个真实请求', async () => {
    const registry = new ModuleActionDraftRegistry();
    registry.save(completeDraft(1));
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const submit = vi.fn(async () => {
      await barrier;
      return {
        id: 'ticket-one',
        applicationNumber: 'BX-ONE',
        status: '待接单',
        recipients: [],
        recipientCount: 1,
      };
    });
    const messages: string[] = [];
    const attempts = Array.from({ length: 200 }, () =>
      handleModuleActionConversation({
        text: '确认提交',
        sessionId: 'session-1',
        accountId: 'load-account',
        enabled: true,
        registry,
        loadDefaults: async () => defaults,
        submit,
        postMessage: (_role, text) => messages.push(text),
        now: () => 1_000,
      }));

    await Promise.resolve();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(messages.filter((message) => message.includes('请勿重复操作'))).toHaveLength(199);
    release?.();
    await Promise.all(attempts);
    expect(registry.activeDraftCount(1_000)).toBe(0);
  }, 10_000);
});
