/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 协议守卫与常量单测。isClientToServer 是 WS 入站第一道闸，边界必须全覆盖。
 */

import { describe, it, expect } from 'vitest';
import {
  isClientToServer,
  validateClientPayload,
  frame,
  HTTP_ROUTES,
  PROTOCOL_VERSION,
  DEFAULT_PORT,
  DEFAULT_HOST,
  type ServerToClient,
} from './protocol.js';

describe('isClientToServer 守卫', () => {
  it('合法 {type,payload} → true', () => {
    expect(isClientToServer({ type: 'list_sessions', payload: {} })).toBe(true);
    expect(
      isClientToServer({ type: 'subscribe', payload: { sessionId: 'x' } }),
    ).toBe(true);
  });

  it('null / undefined → false', () => {
    expect(isClientToServer(null)).toBe(false);
    expect(isClientToServer(undefined)).toBe(false);
  });

  it('字符串 / 数字 / 数组 → false', () => {
    expect(isClientToServer('hello')).toBe(false);
    expect(isClientToServer(42)).toBe(false);
    // 数组是 object，但其 .type 为 undefined（非 string），故守卫判 false。
    expect(isClientToServer([{ type: 'x', payload: {} }])).toBe(false);
    expect(isClientToServer(['a', 'b'])).toBe(false);
    expect(isClientToServer([])).toBe(false);
  });

  it('缺 type → false', () => {
    expect(isClientToServer({ payload: {} })).toBe(false);
  });

  it('缺 payload → false', () => {
    expect(isClientToServer({ type: 'list_sessions' })).toBe(false);
  });

  it('type 非 string → false', () => {
    expect(isClientToServer({ type: 123, payload: {} })).toBe(false);
    expect(isClientToServer({ type: null, payload: {} })).toBe(false);
  });
});

describe('validateClientPayload 形状校验（第二道闸）', () => {
  it('合法 send_user_message → null（通过）', () => {
    expect(
      validateClientPayload({
        type: 'send_user_message',
        payload: {
          sessionId: 's1',
          content: [{ type: 'text', value: 'hi' }],
          source: 'local',
        },
      }),
    ).toBeNull();
  });

  it('accepts bounded authorized enterprise context and rejects forged oversized payloads', () => {
    expect(
      validateClientPayload({
        type: 'send_user_message',
        payload: {
          sessionId: 's1',
          content: [{ type: 'text', value: 'hi' }],
          source: 'local',
          authorizedContext: '[企业知识#1] 已审核流程',
        },
      }),
    ).toBeNull();
    expect(
      validateClientPayload({
        type: 'send_user_message',
        payload: {
          sessionId: 's1',
          content: [{ type: 'text', value: 'hi' }],
          source: 'local',
          authorizedContext: 'x'.repeat(12_001),
        },
      }),
    ).toContain('authorizedContext');
    expect(
      validateClientPayload({
        type: 'send_user_message',
        payload: {
          sessionId: 's1',
          content: [{ type: 'text', value: 'hi' }],
          source: 'local',
          authorizedContext: { content: 'not a string' },
        },
      }),
    ).toContain('authorizedContext');
  });

  it('客户端不得伪造 feishu 来源（飞书消息只允许由服务端适配器注入）', () => {
    expect(
      validateClientPayload({
        type: 'send_user_message',
        payload: {
          sessionId: 's1',
          content: [{ type: 'text', value: 'hi' }],
          source: 'feishu',
        },
      }),
    ).toContain('feishu');
  });

  it('send_user_message：content 传字符串 / null / 对象 → 拒绝', () => {
    for (const content of ['不是数组', null, { type: 'text', value: 'x' }]) {
      expect(
        validateClientPayload({
          type: 'send_user_message',
          payload: { sessionId: 's1', content, source: 'local' },
        }),
      ).not.toBeNull();
    }
  });

  it('send_user_message：content 数组内片段畸形 → 拒绝', () => {
    expect(
      validateClientPayload({
        type: 'send_user_message',
        payload: {
          sessionId: 's1',
          content: [{ type: 'text', value: 42 }],
          source: 'local',
        },
      }),
    ).not.toBeNull();
    expect(
      validateClientPayload({
        type: 'send_user_message',
        payload: { sessionId: 's1', content: [null], source: 'local' },
      }),
    ).not.toBeNull();
  });

  it('send_user_message：sessionId 空 / source 非法 → 拒绝', () => {
    expect(
      validateClientPayload({
        type: 'send_user_message',
        payload: {
          sessionId: '',
          content: [{ type: 'text', value: 'x' }],
          source: 'local',
        },
      }),
    ).not.toBeNull();
    expect(
      validateClientPayload({
        type: 'send_user_message',
        payload: {
          sessionId: 's1',
          content: [{ type: 'text', value: 'x' }],
          source: 'evil',
        },
      }),
    ).not.toBeNull();
  });

  it('未知 type → 拒绝', () => {
    expect(
      validateClientPayload({ type: 'nope_type', payload: {} }),
    ).not.toBeNull();
  });

  it('subscribe / cancel / set_model：sessionId 缺失或非字符串 → 拒绝', () => {
    expect(
      validateClientPayload({ type: 'subscribe', payload: {} }),
    ).not.toBeNull();
    expect(
      validateClientPayload({ type: 'cancel', payload: { sessionId: 1 } }),
    ).not.toBeNull();
    expect(
      validateClientPayload({
        type: 'set_model',
        payload: { sessionId: 's1' },
      }),
    ).not.toBeNull();
    expect(
      validateClientPayload({
        type: 'set_model',
        payload: { sessionId: 's1', model: 'm1' },
      }),
    ).toBeNull();
  });

  it('save_custom_model：必填字段缺失 → 拒绝；齐全 → 通过', () => {
    expect(
      validateClientPayload({
        type: 'save_custom_model',
        payload: { baseUrl: 'https://x', apiKey: 'k', modelId: 'm' },
      }),
    ).not.toBeNull();
    expect(
      validateClientPayload({
        type: 'save_custom_model',
        payload: {
          provider: 'openai',
          baseUrl: 'https://x',
          apiKey: 'k',
          modelId: 'm',
        },
      }),
    ).toBeNull();
    expect(
      validateClientPayload({
        type: 'save_custom_model',
        payload: {
          provider: 'openai',
          baseUrl: 'https://x',
          apiKey: '',
          modelId: 'm',
          replaceId: 'custom:openai:old@abc',
        },
      }),
    ).toBeNull();
    expect(
      validateClientPayload({
        type: 'save_custom_model',
        payload: {
          provider: 'openai',
          baseUrl: 'https://x',
          apiKey: '',
          modelId: 'm',
          replaceId: 123,
        },
      }),
    ).not.toBeNull();
  });

  it('delete_session：sessionId 缺失 → 拒绝；齐全 → 通过', () => {
    expect(
      validateClientPayload({ type: 'delete_session', payload: {} }),
    ).not.toBeNull();
    expect(
      validateClientPayload({
        type: 'delete_session',
        payload: { sessionId: 's1' },
      }),
    ).toBeNull();
  });

  it('rename_session：sessionId/title 校验（空白 title 拒绝，齐全通过）', () => {
    // sessionId 缺失
    expect(
      validateClientPayload({
        type: 'rename_session',
        payload: { title: '新名' },
      }),
    ).not.toBeNull();
    // title 非字符串
    expect(
      validateClientPayload({
        type: 'rename_session',
        payload: { sessionId: 's1', title: 42 },
      }),
    ).not.toBeNull();
    // title 纯空白
    expect(
      validateClientPayload({
        type: 'rename_session',
        payload: { sessionId: 's1', title: '   ' },
      }),
    ).not.toBeNull();
    // 齐全通过
    expect(
      validateClientPayload({
        type: 'rename_session',
        payload: { sessionId: 's1', title: '新名' },
      }),
    ).toBeNull();
  });

  it('payload 非对象（null / 字符串）→ 拒绝', () => {
    expect(
      validateClientPayload({ type: 'list_sessions', payload: null }),
    ).not.toBeNull();
    expect(
      validateClientPayload({ type: 'get_history', payload: 'x' }),
    ).not.toBeNull();
  });

  it('v1.7 企业关联和自动 Skill 操作只接受非空链接/候选 ID', () => {
    expect(validateClientPayload({
      type: 'accept_company_link',
      payload: { link: 'otto://enterprise/join?token=abc' },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'accept_company_link',
      payload: { link: '' },
    })).not.toBeNull();
    expect(validateClientPayload({
      type: 'get_pending_auto_skills',
      payload: {},
    })).toBeNull();
    expect(validateClientPayload({
      type: 'scan_pending_auto_skills',
      payload: {},
    })).toBeNull();
    for (const type of ['confirm_pending_auto_skill', 'reject_pending_auto_skill']) {
      expect(validateClientPayload({ type, payload: { candidateId: 'candidate-1' } })).toBeNull();
      expect(validateClientPayload({ type, payload: { candidateId: '' } })).not.toBeNull();
    }
  });
});

describe('frame 构造器', () => {
  it('恒等返回入参', () => {
    const f: ServerToClient = {
      type: 'welcome',
      payload: { protocolVersion: '1', serverVersion: '0.1.0' },
    };
    expect(frame(f)).toBe(f);
  });
});

describe('HTTP_ROUTES 与常量', () => {
  it('sessionHistory 拼串正确', () => {
    expect(HTTP_ROUTES.sessionHistory('abc')).toBe('/sessions/abc/history');
  });

  it('静态路由值', () => {
    expect(HTTP_ROUTES.health).toBe('/health');
    expect(HTTP_ROUTES.sessions).toBe('/sessions');
    expect(HTTP_ROUTES.models).toBe('/models');
    expect(HTTP_ROUTES.enterpriseIdentity).toBe('/internal/enterprise-identity');
    expect(HTTP_ROUTES.channelInstallations).toBe('/channels/installations');
    expect(HTTP_ROUTES.channelIdentities('channel_lark_1'))
      .toBe('/channels/installations/channel_lark_1/identities');
    expect(HTTP_ROUTES.channelInstallation('channel_lark_abc')).toBe(
      '/channels/installations/channel_lark_abc',
    );
    expect(HTTP_ROUTES.ws).toBe('/ws');
  });

  it('PROTOCOL_VERSION / DEFAULT_PORT / DEFAULT_HOST 冒烟', () => {
    expect(PROTOCOL_VERSION).toBe('1');
    expect(DEFAULT_PORT).toBe(7637);
    expect(DEFAULT_HOST).toBe('127.0.0.1');
  });
});

describe('validateClientPayload：斜杠命令帧（P3）', () => {
  it('run_slash_command 合法 payload 通过', () => {
    expect(
      validateClientPayload({
        type: 'run_slash_command',
        payload: { sessionId: 's1', name: 'kb', args: 'search 报销' },
      }),
    ).toBeNull();
    // args 可省略
    expect(
      validateClientPayload({
        type: 'run_slash_command',
        payload: { sessionId: 's1', name: 'about' },
      }),
    ).toBeNull();
  });

  it('run_slash_command 缺 sessionId / name、args 非法 → 拒绝', () => {
    expect(
      validateClientPayload({
        type: 'run_slash_command',
        payload: { name: 'kb' },
      }),
    ).toContain('sessionId');
    expect(
      validateClientPayload({
        type: 'run_slash_command',
        payload: { sessionId: 's1', name: '' },
      }),
    ).toContain('name');
    expect(
      validateClientPayload({
        type: 'run_slash_command',
        payload: { sessionId: 's1', name: 'kb', args: 42 },
      }),
    ).toContain('args');
  });

  it('list_slash_commands 空对象 payload 通过，非对象拒绝', () => {
    expect(
      validateClientPayload({ type: 'list_slash_commands', payload: {} }),
    ).toBeNull();
    expect(
      validateClientPayload({ type: 'list_slash_commands', payload: null }),
    ).not.toBeNull();
  });

  it('搜索配置接口只接受受支持 provider、HTTPS API 地址和字符串模型', () => {
    expect(
      validateClientPayload({ type: 'get_search_config', payload: {} }),
    ).toBeNull();
    expect(
      validateClientPayload({
        type: 'save_search_config',
        payload: {
          provider: 'volcengine',
          apiUrl: 'https://ark.cn-beijing.volces.com/api/v3/responses',
          model: 'doubao-seed-2-0-lite-260215',
          apiKey: 'secret',
          costPerRequestCny: 0.01,
          monthlyRequestQuota: 1000,
          monthlyBudgetCny: 50,
        },
      }),
    ).toBeNull();
    expect(
      validateClientPayload({
        type: 'save_search_config',
        payload: { provider: 'unknown' },
      }),
    ).toContain('provider');
    expect(
      validateClientPayload({
        type: 'save_search_config',
        payload: { provider: 'volcengine', apiUrl: 'http://insecure.example.com' },
      }),
    ).toContain('HTTPS');
    expect(
      validateClientPayload({
        type: 'save_search_config',
        payload: { provider: 'bing', monthlyRequestQuota: -1 },
      }),
    ).toContain('monthlyRequestQuota');
  });
  });

describe('validateClientPayload：执行授权', () => {
  it('只接受合法 mode 与 scope', () => {
    expect(validateClientPayload({
      type: 'set_authorization_mode',
      payload: { sessionId: 's1', mode: 'auto', scope: 'session' },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'set_authorization_mode',
      payload: { sessionId: 's1', mode: 'yolo', scope: 'all' },
    })).toContain('mode');
    expect(validateClientPayload({
      type: 'set_authorization_mode',
      payload: { sessionId: 's1', mode: 'manual', scope: 'forever' },
    })).toContain('scope');
  });
});

describe('validateClientPayload：MCP 候选与草稿', () => {
  it('只接受结构化搜索、审计和草稿预览请求', () => {
    expect(validateClientPayload({
      type: 'mcp_catalog_search',
      payload: { query: 'github issues' },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'mcp_candidate_audit',
      payload: { candidateId: 'io.example/test@1.0.0' },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'mcp_candidate_probe',
      payload: { auditId: 'mcp-audit-1', confirmed: true },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'mcp_install_reviewed',
      payload: { auditId: 'mcp-audit-1', confirmed: true },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'mcp_creator_preview',
      payload: {
        name: 'orders',
        description: 'read orders',
        inputKind: 'openapi',
        sourceText: '{"openapi":"3.1.0"}',
        transport: 'stdio',
        environmentVariables: ['ORDERS_TOKEN'],
      },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'mcp_creator_save_draft',
      payload: { draftId: 'mcp-draft-123', confirmed: true },
    })).toBeNull();
  });

  it('拒绝空搜索、伪造输入类型和无正文草稿', () => {
    expect(validateClientPayload({
      type: 'mcp_catalog_search',
      payload: { query: '' },
    })).not.toBeNull();
    expect(validateClientPayload({
      type: 'mcp_candidate_probe',
      payload: { auditId: 'mcp-audit-1', confirmed: false },
    })).not.toBeNull();
    expect(validateClientPayload({
      type: 'mcp_creator_preview',
      payload: {
        name: 'orders',
        description: 'read orders',
        inputKind: 'shell',
        sourceText: '',
        transport: 'stdio',
      },
    })).not.toBeNull();
    expect(validateClientPayload({
      type: 'mcp_creator_save_draft',
      payload: { draftId: 'mcp-draft-123', confirmed: false },
    })).not.toBeNull();
  });

  it('拒绝旧直连安装入口、超长句柄和环境变量洪泛', () => {
    expect(validateClientPayload({
      type: 'mcp_add',
      payload: { name: 'bypass', command: 'node', args: ['evil.js'] },
    })).toContain('停用');
    expect(validateClientPayload({
      type: 'mcp_candidate_audit',
      payload: { candidateId: 'x'.repeat(513) },
    })).toContain('candidateId');
    expect(validateClientPayload({
      type: 'mcp_candidate_probe',
      payload: { auditId: `mcp-audit-${'a'.repeat(500)}`, confirmed: true },
    })).toContain('auditId');
    expect(validateClientPayload({
      type: 'mcp_creator_preview',
      payload: {
        name: 'orders', description: 'orders', inputKind: 'natural_language',
        sourceText: 'create a server', transport: 'stdio',
        environmentVariables: Array.from({ length: 65 }, (_, index) => `TOKEN_${index}`),
      },
    })).toContain('environmentVariables');
    expect(validateClientPayload({
      type: 'mcp_creator_preview',
      payload: {
        name: 'orders', description: 'orders', inputKind: 'natural_language',
        sourceText: 'create a server', transport: 'stdio',
        environmentVariables: ['PATH=attacker'],
      },
    })).toContain('environmentVariables');
  });

  it('只接受服务器生成格式的审计和草稿句柄', () => {
    expect(validateClientPayload({
      type: 'mcp_candidate_probe',
      payload: { auditId: 'audit-from-other-system', confirmed: true },
    })).toContain('auditId');
    expect(validateClientPayload({
      type: 'mcp_creator_save_draft',
      payload: { draftId: '../../draft', confirmed: true },
    })).toContain('draftId');
  });

  it('按 UTF-8 字节而不是 JavaScript 字符数限制 MCP 生成输入', () => {
    expect(validateClientPayload({
      type: 'mcp_creator_preview',
      payload: {
        name: 'orders', description: 'orders', inputKind: 'api_docs',
        sourceText: '😀'.repeat(600_000), transport: 'stdio',
      },
    })).toContain('2MB');
  });

  it('对 1000 组确定性畸形 MCP payload fail closed 且验证器不崩溃', () => {
    let seed = 0x5eed1234;
    const next = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed;
    };
    const values: unknown[] = [null, false, true, -1, 0, Number.NaN, '', 'x', [], {}, { nested: [] }];
    const types = [
      'mcp_catalog_search', 'mcp_candidate_audit', 'mcp_candidate_probe',
      'mcp_install_reviewed', 'mcp_creator_preview', 'mcp_creator_save_draft', 'mcp_add',
    ] as const;
    for (let index = 0; index < 1_000; index += 1) {
      const type = types[next() % types.length]!;
      const payload = values[next() % values.length];
      expect(() => validateClientPayload({ type, payload } as never)).not.toThrow();
      expect(validateClientPayload({ type, payload } as never)).not.toBeNull();
    }
  });
});

describe('validateClientPayload：工作目录', () => {
  it('只接受会话 id 与非空绝对目录字符串', () => {
    expect(validateClientPayload({
      type: 'set_session_workspace',
      payload: { sessionId: 's1', workspacePath: '/Users/yang/project' },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'set_session_workspace',
      payload: { sessionId: '', workspacePath: '/Users/yang/project' },
    })).toContain('sessionId');
    expect(validateClientPayload({
      type: 'set_session_workspace',
      payload: { sessionId: 's1', workspacePath: '   ' },
    })).toContain('workspacePath');
  });

  it('项目级设置请求支持会话目录，并兼容旧客户端的空 payload', () => {
    expect(validateClientPayload({
      type: 'get_memory',
      payload: { sessionId: 's1' },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'get_extensions',
      payload: {},
    })).toBeNull();
    expect(validateClientPayload({
      type: 'get_skills',
      payload: { sessionId: 7 },
    })).toContain('sessionId');
    expect(validateClientPayload({
      type: 'add_memory',
      payload: { sessionId: 's1', fact: '使用中文' },
    })).toBeNull();
  });
});

describe('validateClientPayload：v1.7 产品工作区', () => {
  it('create_session 只接受字符串 agentProfileId', () => {
    expect(validateClientPayload({
      type: 'create_session',
      payload: { title: '会议', agentProfileId: 'meeting' },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'create_session',
      payload: { title: '会议', agentProfileId: { systemPrompt: 'evil' } },
    })).toContain('agentProfileId');
  });

  it('create_session 的 clientRequestId 可选，存在时必须是非空字符串', () => {
    expect(validateClientPayload({
      type: 'create_session',
      payload: { title: '会议' },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'create_session',
      payload: { title: '会议', clientRequestId: 'create-request-1' },
    })).toBeNull();
    for (const clientRequestId of ['', '   ', 42]) {
      expect(validateClientPayload({
        type: 'create_session',
        payload: { title: '会议', clientRequestId },
      })).toContain('clientRequestId');
    }
  });

  it('管理者建档和加入企业严格校验必填字段', () => {
    expect(validateClientPayload({
      type: 'configure_enterprise',
      payload: { managerName: '陈晨', companyName: '北辰科技', industry: '企业软件' },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'configure_enterprise',
      payload: { managerName: '', companyName: '北辰科技' },
    })).toContain('managerName');
    expect(validateClientPayload({
      type: 'join_enterprise',
      payload: { link: 'otto://enterprise/join?x=1', userId: 'u1', displayName: '林一' },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'join_enterprise',
      payload: { link: '', userId: 'u1', displayName: '林一' },
    })).toContain('link');
  });

  it('企业邀请按 kind 校验职位或父子公司参数', () => {
    expect(validateClientPayload({
      type: 'create_enterprise_invite',
      payload: { kind: 'position', departmentId: 'd1', positionId: 'p1' },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'create_enterprise_invite',
      payload: { kind: 'position', departmentId: 'd1' },
    })).toContain('positionId');
    expect(validateClientPayload({
      type: 'create_enterprise_invite',
      payload: { kind: 'company_link', direction: 'parent_invites_child' },
    })).toBeNull();
  });

  it('本地日程帧校验 action 所需字段', () => {
    expect(validateClientPayload({
      type: 'create_schedule',
      payload: { title: '复盘', startAt: '2026-07-12T09:00:00+08:00' },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'create_schedule',
      payload: { title: '', startAt: 'bad' },
    })).toContain('title');
    expect(validateClientPayload({
      type: 'get_schedules',
      payload: { date: '2026-07-12', timezone: 'Asia/Shanghai' },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'delete_schedule',
      payload: { id: '' },
    })).toContain('id');
  });
});
