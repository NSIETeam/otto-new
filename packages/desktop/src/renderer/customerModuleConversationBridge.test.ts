/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import {
  CustomerModuleConversationDraftRegistry,
  handleCustomerModuleConversation,
} from './customerModuleConversationBridge.js';

const modules = [{
  id: 'contract-review', version: '1.2.0', name: '合同审查器', description: '审查合同风险',
  enabled: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      contractText: { type: 'string', title: '合同内容' },
      riskLevel: { type: 'string', title: '风险等级', enum: ['低', '中', '高'] },
      includeSuggestions: { type: 'boolean', title: '包含修改建议' },
    },
    required: ['contractText', 'riskLevel'],
  },
  permissions: [{ kind: 'model', paid: true, provider: 'deepseek' }],
}];

function harness(overrides: Record<string, unknown> = {}) {
  const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  const runModule = vi.fn(async () => ({
    result: { status: 'completed' as const, exitCode: 0, output: '发现 2 项风险' },
    audit: [],
    hostAudit: [{ capability: 'model', provider: 'deepseek', inputTokens: 100, outputTokens: 20 }],
  }));
  const registry = new CustomerModuleConversationDraftRegistry();
  return {
    registry, messages, runModule,
    common: {
      text: '', sessionId: 'session-1', accountId: 'account-1', enabled: true,
      registry, modules, runModule,
      postMessage: (role: 'user' | 'assistant', text: string) => messages.push({ role, text }),
      now: () => 1_000,
      ...overrides,
    },
  };
}

describe('客户模块通用 Schema 对话桥', () => {
  it('按模块名称识别运行意图，并只追问 Schema 必填项', async () => {
    const { common, messages, registry } = harness();
    expect(await handleCustomerModuleConversation({ ...common, text: '使用合同审查器' })).toBe(true);
    expect(messages.at(-1)?.text).toContain('合同内容');
    expect(messages.at(-1)?.text).toContain('风险等级');
    expect(messages.at(-1)?.text).not.toContain('包含修改建议、');
    expect(registry.get('session-1', 'account-1', 1_000)?.moduleId).toBe('contract-review');
  });

  it('解析字符串、枚举和布尔字段，展示权限与Token费用确认', async () => {
    const { common, messages, runModule } = harness();
    await handleCustomerModuleConversation({ ...common, text: '运行合同审查器，合同内容：甲方应付款，风险等级：高，包含修改建议：是' });
    const summary = messages.at(-1)?.text ?? '';
    expect(summary).toContain('甲方应付款');
    expect(summary).toContain('风险等级：高');
    expect(summary).toContain('可能产生模型 Token 费用');
    expect(runModule).not.toHaveBeenCalled();

    await handleCustomerModuleConversation({ ...common, text: '确认运行并同意费用' });
    expect(runModule).toHaveBeenCalledWith(expect.objectContaining({
      moduleId: 'contract-review', version: '1.2.0', runId: expect.any(String),
      formInput: { contractText: '甲方应付款', riskLevel: '高', includeSuggestions: true },
    }));
    expect(messages.at(-1)?.text).toContain('发现 2 项风险');
    expect(messages.at(-1)?.text).toContain('Token 120');
  });

  it('单一缺失文本字段允许直接补充，不要求重复字段名', async () => {
    const single = [{
      id: 'summary', version: '1.0.0', name: '文本摘要', description: '', enabled: true,
      inputSchema: { type: 'object' as const, properties: { text: { type: 'string', title: '原文' } }, required: ['text'] },
      permissions: [],
    }];
    const { common, messages } = harness({ modules: single });
    await handleCustomerModuleConversation({ ...common, text: '运行文本摘要' });
    await handleCustomerModuleConversation({ ...common, text: '这是需要摘要的正文' });
    expect(messages.at(-1)?.text).toContain('原文：这是需要摘要的正文');
    expect(messages.at(-1)?.text).toContain('确认运行');
  });

  it('禁用模块、功能介绍和未命名模块不会被拦截', async () => {
    const disabled = [{ ...modules[0]!, enabled: false, suspendedReason: '安全审查中' }];
    for (const input of [
      { modules: disabled, text: '运行合同审查器' },
      { modules, text: '介绍一下合同审查器功能' },
      { modules, text: '运行一个不存在的模块' },
    ]) {
      const { common, messages } = harness({ modules: input.modules });
      expect(await handleCustomerModuleConversation({ ...common, text: input.text })).toBe(false);
      expect(messages).toHaveLength(0);
    }
  });

  it('拒绝对话桥不支持的必填对象字段，提示改用右侧模块', async () => {
    const complex = [{
      id: 'complex', version: '1', name: '复杂模块', description: '', enabled: true,
      inputSchema: { type: 'object' as const, properties: { config: { type: 'object', title: '高级配置' } }, required: ['config'] },
      permissions: [],
    }];
    const { common, messages, registry } = harness({ modules: complex });
    expect(await handleCustomerModuleConversation({ ...common, text: '运行复杂模块' })).toBe(true);
    expect(messages.at(-1)?.text).toContain('右侧模块界面');
    expect(registry.get('session-1', 'account-1', 1_000)).toBeNull();
  });

  it('取消草稿不会运行模块，草稿严格隔离账号和会话', async () => {
    const { common, messages, registry, runModule } = harness();
    await handleCustomerModuleConversation({ ...common, text: '运行合同审查器' });
    expect(registry.get('session-1', 'account-2', 1_000)).toBeNull();
    await handleCustomerModuleConversation({ ...common, text: '取消' });
    expect(messages.at(-1)?.text).toContain('不会运行');
    expect(runModule).not.toHaveBeenCalled();
  });

  it('运行失败不会伪报成功，并要求用户明确决定是否重新运行', async () => {
    const runModule = vi.fn(async () => { throw new Error('宿主超时'); });
    const { common, messages } = harness({ runModule });
    await handleCustomerModuleConversation({ ...common, text: '运行合同审查器，合同内容：测试，风险等级：低' });
    await handleCustomerModuleConversation({ ...common, text: '确认运行并同意费用' });
    expect(messages.at(-1)?.text).toContain('宿主超时');
    expect(messages.at(-1)?.text).toContain('重新运行');
  });
});
