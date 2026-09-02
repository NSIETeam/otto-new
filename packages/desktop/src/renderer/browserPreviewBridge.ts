/**
 * 浏览器静态预览桥。
 *
 * Electron 会由 preload 注入 window.otto；只有普通浏览器缺少该对象时才启用这里的
 * 纯本地模拟实现。它不访问园区服务器，所有会话、模型和回复均为演示数据。
 */

import { parkISODate, parkMinuteOfDay } from './parkBusinessTime.js';

type PreviewFrame = { type: string; payload: Record<string, unknown> };
type PreviewWindow = { otto?: unknown };

const previewWindow = window as unknown as PreviewWindow;

if (!previewWindow.otto) {
  const frameHandlers = new Set<(frame: PreviewFrame) => void>();
  const connectionHandlers = new Set<(connected: boolean) => void>();
  const modelStorageKey = 'otto:browser-preview-models';
  let connected = false;
  let currentModel: string | null = 'preview-model';
  let sessions = [makeSession('preview-session', '园区服务本地演示')];
  let models = readModels();
  const previewAccount = {
    id: 'browser-dev',
    organizationId: 'preview-park-admin',
    organizationName: '宏创园区管理方',
    accountType: 'enterprise',
    employeeId: null,
    username: 'park.admin',
    phone: '+8613800000000',
    name: '园区管理员',
    role: '园区管理员',
    department: '园区管理部',
    departmentId: 'preview-park-dept',
    positionId: null,
    positionTitle: '园区管理员',
    isAdmin: true,
    status: 'active',
    tags: ['园区管理员'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const previewTenantOrganizations = [
    { id: 'preview-tenant-smart', name: '宏创智能制造', slug: 'hongchuang-smart', parkId: 'preview-park', status: 'active', industry: '智能制造', employeeCount: 36, departmentCount: 4, onlineCount: 12, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    { id: 'preview-tenant-digital', name: '北辰数字科技', slug: 'beichen-digital', parkId: 'preview-park', status: 'active', industry: '软件与信息服务', employeeCount: 24, departmentCount: 3, onlineCount: 8, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    { id: 'preview-tenant-logistics', name: '远达供应链', slug: 'yuanda-logistics', parkId: 'preview-park', status: 'active', industry: '现代物流', employeeCount: 18, departmentCount: 3, onlineCount: 5, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  ];
  let previewPublicProfile = {
    organizationId: previewAccount.organizationId,
    organizationName: previewAccount.organizationName,
    summary: '为园区企业提供运营、资源对接与公共服务。',
    website: 'https://example.com/hongchuang',
    industryTags: ['园区运营', '企业服务'],
    productsServices: ['园区运营服务', '会议与活动空间'],
    capabilities: ['企业资源对接', '园区数字化运营'],
    cooperationNeeds: ['智能制造解决方案', '企业数字化服务'],
    publicContact: '合作邮箱 park@example.com',
    isPublic: true,
    updatedAt: new Date().toISOString(),
  };
  let previewTickets: Array<Record<string, unknown>> = [];
  let previewPolicyState = {
    enabled: false,
    profile: { organizationName: previewAccount.organizationName },
    policies: [] as Array<Record<string, unknown>>,
    assessments: [] as Array<Record<string, unknown>>,
    syncStatus: 'idle',
  };
  let previewCarpoolState: Record<string, unknown> = {
    capability: 'park_carpool_v1', mapConfigured: true, parkId: 'preview-park',
    currentIntent: null, matches: [], generatedAt: new Date().toISOString(),
  };
  const previewParkPublications: Array<Record<string, unknown>> = [
    {
      id: 'preview-publication-announcement',
      kind: 'announcement',
      title: '园区公共区域维护通知',
      body: '本周六 09:00–12:00 对公共区域进行例行维护，请各企业提前安排好出入和访客接待。',
      createdAt: new Date(Date.now() - 45 * 60_000).toISOString(),
      readAt: null,
      submittedAt: null,
      responseData: null,
      recipientCount: 78,
      readCount: 41,
    },
    {
      id: 'preview-publication-satisfaction',
      kind: 'satisfaction',
      title: '2026 年第二季度园区服务满意度调查',
      body: '请结合本季度使用体验，对物业、会议室、停车和网络等园区服务进行评价。',
      createdAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      readAt: null,
      submittedAt: null,
      responseData: null,
      recipientCount: 78,
      readCount: 32,
    },
  ];
  const previewDirectMessages = new Map<string, Array<Record<string, unknown>>>();
  // 演示未读：演示同事发来两条消息未读，打开会话后（listMessages）清除，模拟后端标已读
  const previewUnread = new Map<string, Record<string, unknown>>();
  let previewApplicationSequence = 0;
  const previewMeetingSlots = makePreviewMeetingSlots();

  function makePreviewMeetingSlots(): Array<Record<string, unknown>> {
    const roomIds = [
      'preview-room-medium',
      'preview-room-large',
      'preview-room-auditorium',
    ];
    const slots: Array<Record<string, unknown>> = [];
    const referenceTime = new Date();
    const currentMinutes = parkMinuteOfDay(referenceTime);
    for (let day = 0; day <= 30; day += 1) {
      for (const roomId of roomIds) {
        for (let minutes = 9 * 60; minutes < 23 * 60; minutes += 10) {
          const key = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
          const end = minutes + 10;
          const endKey = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
          slots.push({
            id: `${roomId}-${parkISODate(referenceTime, day)}-${key}`,
            roomId,
            date: parkISODate(referenceTime, day),
            slotKey: key,
            label: `${key}–${endKey}`,
            status:
              day === 0 && minutes <= currentMinutes
                ? 'closed'
                : day === 1 &&
                    roomId === 'preview-room-medium' &&
                    key === '10:00'
                  ? 'booked'
                  : 'available',
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }
    return slots;
  }

  function makeSession(
    sessionId: string,
    title: string,
  ): Record<string, unknown> {
    return {
      sessionId,
      title,
      model: currentModel,
      status: 'idle',
      messageCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  function readModels(): Array<Record<string, unknown>> {
    try {
      const stored: unknown = JSON.parse(
        localStorage.getItem(modelStorageKey) ?? '[]',
      );
      if (Array.isArray(stored) && stored.length > 0)
        return stored as Array<Record<string, unknown>>;
    } catch {
      /* 隐私模式或损坏数据时使用默认模型 */
    }
    return [
      {
        id: 'preview-model',
        displayName: 'GPT-5.1',
        provider: 'openai',
        enabled: true,
      },
    ];
  }
  function persistModels(): void {
    try {
      localStorage.setItem(modelStorageKey, JSON.stringify(models));
    } catch {
      /* 不可持久化时仍可在当前页使用 */
    }
  }
  function emit(type: string, payload: Record<string, unknown>): void {
    const frame = { type, payload };
    frameHandlers.forEach((handler) => {
      try {
        handler(frame);
      } catch {
        /* 单个监听器不阻断 */
      }
    });
  }
  function emitModels(): void {
    emit('models_list', { models, current: currentModel });
  }
  function id(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  // —— 演示会话种子数据：让「我的消息」和导航未读角标在预览中有真实联动 ——
  previewDirectMessages.set('preview-colleague', [
    {
      id: id('preview-message'),
      senderAccountId: 'preview-colleague',
      recipientAccountId: previewAccount.id,
      content: '下午三点的项目例会改到中型会议室了，记得提前五分钟到。',
      createdAt: new Date(Date.now() - 40 * 60_000).toISOString(),
      readAt: null,
    },
    {
      id: id('preview-message'),
      senderAccountId: 'preview-colleague',
      recipientAccountId: previewAccount.id,
      content: '上次说的报修工单模板我放在共享文档里了，你看下格式对不对。',
      createdAt: new Date(Date.now() - 12 * 60_000).toISOString(),
      readAt: null,
    },
  ]);
  previewUnread.set('preview-colleague', {
    id: id('preview-notification'),
    source: 'enterprise',
    title: '演示同事',
    senderAccountId: 'preview-colleague',
    senderName: '演示同事',
    preview: '上次说的报修工单模板我放在共享文档里了，你看下格式对不对。',
    createdAt: new Date(Date.now() - 12 * 60_000).toISOString(),
  });

  const previewDepartments = [{
    id: 'preview-park-dept',
    organizationId: previewAccount.organizationId,
    name: '园区管理部',
    parentDepartmentId: null,
    memberCount: 1,
    positions: [{
      id: 'preview-park-admin-position',
      organizationId: previewAccount.organizationId,
      departmentId: 'preview-park-dept',
      title: '园区管理员',
      roleMapping: 'enterprise_admin',
      createdAt: previewAccount.createdAt,
      updatedAt: previewAccount.updatedAt,
    }],
    createdAt: previewAccount.createdAt,
    updatedAt: previewAccount.updatedAt,
  }];
  const bridge: Record<string, unknown> = {
    connect: () => {
      connected = true;
      connectionHandlers.forEach((handler) => {
        try {
          handler(true);
        } catch {
          /* 忽略 */
        }
      });
      window.setTimeout(() => {
        emit('sessions_list', { sessions });
        emitModels();
      }, 40);
      return Promise.resolve(true);
    },
    disconnect: () => {
      connected = false;
      connectionHandlers.forEach((handler) => {
        try {
          handler(false);
        } catch {
          /* 忽略 */
        }
      });
    },
    isConnected: () => connected,
    onFrame: (handler: (frame: PreviewFrame) => void) => {
      frameHandlers.add(handler);
      return () => frameHandlers.delete(handler);
    },
    onConnectionChange: (handler: (state: boolean) => void) => {
      connectionHandlers.add(handler);
      try {
        handler(connected);
      } catch {
        /* 忽略 */
      }
      return () => connectionHandlers.delete(handler);
    },
    send: (frame: { type?: string; payload?: Record<string, unknown> }) => {
      const payload = frame.payload ?? {};
      if (frame.type === 'list_sessions') emit('sessions_list', { sessions });
      if (frame.type === 'get_models' || frame.type === 'list_models')
        emitModels();
      if (frame.type === 'get_history')
        emit('history', { sessionId: payload.sessionId, messages: [] });
      if (frame.type === 'create_session') {
        const session = makeSession(
          id('preview-session'),
          String(payload.title ?? '新对话'),
        );
        sessions = [session, ...sessions];
        emit('session_created', {
          session,
          clientRequestId: payload.clientRequestId,
        });
      }
      if (frame.type === 'set_model') {
        currentModel = String(payload.model ?? currentModel);
        sessions = sessions.map((session) =>
          session.sessionId === payload.sessionId
            ? { ...session, model: currentModel, updatedAt: Date.now() }
            : session,
        );
        emitModels();
      }
      if (frame.type === 'save_custom_model') {
        const provider = String(payload.provider ?? 'openai');
        const modelId = String(payload.modelId ?? 'gpt-5.1');
        const model = {
          id: String(
            payload.replaceId ?? `custom:${provider}:${modelId}:${Date.now()}`,
          ),
          displayName: String(payload.displayName ?? modelId),
          provider,
          baseUrl: String(payload.baseUrl ?? ''),
          enabled: true,
          isCustom: true,
        };
        models = [...models.filter((item) => item.id !== model.id), model];
        currentModel = model.id;
        persistModels();
        window.setTimeout(emitModels, 50);
      }
      if (frame.type === 'delete_custom_model') {
        models = models.filter((item) => item.id !== payload.id);
        if (!models.some((item) => item.id === currentModel))
          currentModel = String(models[0]?.id ?? '');
        persistModels();
        window.setTimeout(emitModels, 50);
      }
      if (frame.type === 'send_user_message') {
        const sessionId = String(payload.sessionId ?? 'preview-session');
        const messageId = id('assistant');
        emit('message_start', {
          message: {
            id: messageId,
            sessionId,
            role: 'assistant',
            content: [{ type: 'text', value: '' }],
            timestamp: Date.now(),
            source: 'local',
            isStreaming: true,
          },
        });
        window.setTimeout(() => {
          const text =
            '这是浏览器本地预览。园区服务的完整模拟流程可在右侧「园区服务」中演示。';
          emit('chat_chunk', { sessionId, messageId, delta: text });
          emit('chat_complete', {
            sessionId,
            messageId,
            text,
            finishReason: 'stop',
          });
        }, 160);
      }
    },
    parkConfig: () => Promise.resolve(null),
    onMenu: () => () => {},
    onUpdateProgress: () => () => {},
    onNotificationUnreadChanged: () => () => {},
    onNotificationSessionOpen: () => () => {},
    onEnterpriseRegistrationIntent: () => () => {},
    onEnterpriseSessionInvalidated: () => () => {},
    onEnterpriseAccountUpdated: () => () => {},
    notificationShow: () => Promise.resolve(),
    notificationMarkRead: () => Promise.resolve(),
    notificationGetUnread: () => Promise.resolve([]),
    conversationDraftLoad: () => Promise.resolve(null),
    conversationDraftSave: () => Promise.resolve(),
    conversationDraftRemove: () => Promise.resolve(),
    appVersion: () => Promise.resolve('1.9.14-browser-preview'),
    getWorkspaceDirectories: () => Promise.resolve({
      defaultPath: '/Users/demo',
      recentPaths: ['/Users/demo'],
    }),
    selectWorkspaceDirectory: () => Promise.resolve(null),
    recruitmentTranscribe: () => Promise.reject(
      new Error('浏览器预览不支持本地 WhisperX 面试转写'),
    ),
    recruitmentAnalyzeResume: () => Promise.resolve({
      summary: '候选人具备企业应用交付经验，核心技术与岗位较贴合；仍需核实复杂系统规模和个人决策边界。',
      overallScore: 82,
      matchLevel: 'good' as const,
      evidenceCoverage: 80,
      dimensions: [
        { id: 'core_capability' as const, label: '核心能力', score: 86, assessment: '技术实践与岗位核心工作较贴合。', evidence: [{ line: 3, quote: '使用 React 和 TypeScript 开发企业系统' }], uncertainties: [] },
        { id: 'experience_depth' as const, label: '经验深度', score: 80, assessment: '具备连续相关经历。', evidence: [{ line: 2, quote: '2022-2026 星河科技 前端工程师' }], uncertainties: ['复杂度待核实'] },
        { id: 'delivery_impact' as const, label: '交付与结果', score: 84, assessment: '有量化交付结果。', evidence: [{ line: 4, quote: '最终首屏时间降低 30%' }], uncertainties: [] },
        { id: 'role_scope' as const, label: '职责范围', score: 76, assessment: '能够说明本人负责事项。', evidence: [{ line: 4, quote: '负责性能优化' }], uncertainties: ['协作范围待核实'] },
        { id: 'transferability' as const, label: '可迁移能力', score: 79, assessment: '性能和企业应用经验可迁移。', evidence: [{ line: 3, quote: '开发企业系统' }], uncertainties: [] },
      ],
      hardRequirements: [{ requirement: '掌握 React 与 TypeScript', status: 'met' as const, explanation: '有直接项目实践。', evidence: [{ line: 3, quote: '使用 React 和 TypeScript 开发企业系统' }] }],
      strengths: ['企业应用交付', '性能优化'],
      risks: ['系统规模尚不明确'],
      missingInformation: ['团队规模和峰值用户量'],
      interviewQuestions: [{ criterion: '性能优化深度', question: '请说明首屏优化前后的指标口径和你的关键决策。', rationale: '核实量化结果与个人贡献', followUps: ['如何建立基线？'], goodSignals: ['能说明指标、取舍和验证方法'], concernSignals: ['只能复述团队成果'] }],
      analysisVersion: 'otto-recruitment-semantic-v2.0',
      modelProvider: 'browser-preview-model', inputTokens: 0, outputTokens: 0,
      createdAt: new Date().toISOString(),
    }),
    openExternal: () => Promise.resolve(),
    openPath: () => Promise.resolve(),
    inspectLocalPath: () =>
      Promise.resolve({
        exists: false,
        kind: 'missing' as const,
        canOpen: false,
      }),
    activateLocalPath: () =>
      Promise.resolve({ ok: false, error: '浏览器预览不支持打开本地文件' }),
    saveTextFile: () => Promise.resolve(null),
    getPathForFile: (file: File) =>
      (file as File & { path?: string }).path || file.name,
    readClipboardText: () =>
      navigator.clipboard?.readText?.() ?? Promise.resolve(''),
    updateCheck: () =>
      Promise.resolve({
        status: 'up-to-date',
        currentVersion: '1.9.14',
        latestVersion: null,
      }),
    updateDownload: () =>
      Promise.resolve({ ok: false, error: '浏览器预览不支持更新' }),
    updateCancel: () => Promise.resolve(),
    updateInstall: () =>
      Promise.resolve({ ok: false, message: '浏览器预览不支持安装' }),
    themeGet: () => Promise.resolve('dark'),
    themeSet: () => Promise.resolve('dark'),
    enterpriseSession: () =>
      Promise.resolve({
        serverUrl: 'browser-preview://local',
        account: previewAccount,
      }),
    enterpriseLogout: () => Promise.resolve(),
    enterprisePresenceHeartbeat: () => Promise.resolve(),
    enterpriseMessagesUnread: () => Promise.resolve([...previewUnread.values()]),
    enterpriseFederationContactCode: () => Promise.resolve(''),
    enterpriseFederationContactImport: () => Promise.reject(
      new Error('浏览器预览不支持导入跨服务器联系人'),
    ),
    enterpriseFederationContacts: () => Promise.resolve([]),
    enterpriseFederationContactRemove: () => Promise.resolve(false),
    enterpriseFederationMessagesList: () => Promise.resolve([]),
    enterpriseFederationMessageSend: () => Promise.reject(
      new Error('浏览器预览不支持跨服务器私聊'),
    ),
    enterpriseFederationAttachmentSave: () => Promise.resolve(null),
    enterpriseFederationAtoaTasks: () => Promise.resolve([]),
    enterpriseFederationAtoaApprove: () => Promise.reject(
      new Error('浏览器预览不支持跨服务器 A2A'),
    ),
    enterpriseFederationAtoaDeny: () => Promise.reject(
      new Error('浏览器预览不支持跨服务器 A2A'),
    ),
    enterpriseFederationAtoaDispatch: () => Promise.reject(
      new Error('浏览器预览不支持跨服务器 A2A'),
    ),
    enterpriseFederationAtoaRespond: () => Promise.reject(
      new Error('浏览器预览不支持跨服务器 A2A'),
    ),
    enterpriseFederationContactVerification: () => Promise.reject(
      new Error('浏览器预览不支持跨服务器身份核验'),
    ),
    enterpriseFederationContactVerify: () => Promise.reject(
      new Error('浏览器预览不支持跨服务器身份核验'),
    ),
    enterpriseAtoaInbox: () => Promise.resolve([]),
    enterpriseE2eeDevicesList: () =>
      Promise.resolve([
        {
          accountId: previewAccount.id,
          deviceId: 'browser-preview-device',
          deviceName: '浏览器预览设备',
          identitySigningPublicKey: 'preview-signing-key',
          deviceExchangePublicKey: 'preview-exchange-key',
          keyFingerprint: '0'.repeat(64),
          approvalState: 'approved',
          approvedByDeviceId: null,
          approvedAt: new Date().toISOString(),
          isCurrentDevice: true,
          createdAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          revokedAt: null,
        },
      ]),
    enterpriseMessageSecurityReset: () => Promise.resolve(),
    enterpriseE2eeKeyTransparency: () =>
      Promise.resolve({
        accountId: previewAccount.id,
        headSequence: 1,
        headHash: '0'.repeat(64),
        entries: [
          {
            sequence: 1,
            accountId: previewAccount.id,
            deviceId: 'browser-preview-device',
            event: 'bootstrap_approved',
            keyFingerprint: '0'.repeat(64),
            actorDeviceId: null,
            previousHash: '0'.repeat(64),
            entryHash: '0'.repeat(64),
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    enterpriseE2eeDeviceApprove: () =>
      Promise.resolve({
        accountId: previewAccount.id,
        deviceId: 'browser-preview-device',
        deviceName: '浏览器预览设备',
        identitySigningPublicKey: 'preview-signing-key',
        deviceExchangePublicKey: 'preview-exchange-key',
        keyFingerprint: '0'.repeat(64),
        approvalState: 'approved',
        approvedByDeviceId: null,
        approvedAt: new Date().toISOString(),
        isCurrentDevice: true,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        revokedAt: null,
      }),
    enterpriseE2eeDeviceVerification: () =>
      Promise.resolve({
        safetyNumber:
          '00000 00000 00000 00000 00000 00000 00000 00000 00000 00000 00000 00000',
        qrPayload: 'otto-e2ee-verify:v1:e30',
        deviceFingerprints: ['0'.repeat(64), '0'.repeat(64)],
      }),
    enterpriseE2eeDeviceRevoke: () => Promise.resolve(),
    enterpriseE2eeRecoveryExport: () =>
      Promise.resolve('{"v":1,"preview":true}'),
    enterpriseE2eeRecoveryImport: () => Promise.resolve(),
    enterpriseAccounts: () => Promise.resolve([previewAccount]),
    enterpriseOrganizationInviteGet: () => Promise.resolve({
      organization: {
        id: previewAccount.organizationId,
        name: previewAccount.organizationName,
      },
      invite: null,
    }),
    enterpriseOrganizationDepartments: () => Promise.resolve(previewDepartments),
    enterpriseOrganizationFeaturesGet: () => Promise.resolve({
      enterprise_tree: true,
      park_service: true,
      feishu_auto_reply: false,
      direct_messages: true,
      atoa: true,
      knowledge: true,
      skill_market: true,
    }),
    enterpriseOrganizationFeatureStateGet: () => {
      const features = {
        enterprise_tree: true,
        park_service: true,
        feishu_auto_reply: false,
        direct_messages: true,
        atoa: true,
        knowledge: true,
        skill_market: true,
      };
      return Promise.resolve({
        configured: { ...features },
        entitled: { ...features },
        effective: { ...features },
      });
    },
    enterpriseParkServices: () => Promise.resolve([]),
    enterpriseParkSpecialists: () => Promise.resolve([]),
    enterpriseParkAnnouncementResults: () => Promise.resolve([]),
    enterpriseParkSurveyResults: () => Promise.resolve([]),
    enterpriseOrganizationView: (organizationId?: string) => {
      const features = {
        enterprise_tree: true,
        park_service: true,
        feishu_auto_reply: false,
        direct_messages: true,
        atoa: true,
        knowledge: true,
        skill_market: true,
      };
      if (organizationId === 'preview-tenant-smart') {
        const members = [
          { id: 'smart-owner', username: 'smart.owner', name: '李总', role: '企业负责人', department: '管理层', departmentId: 'smart-management', positionId: 'smart-owner-pos', positionTitle: '企业负责人', avatarUrl: null, isAdmin: true, status: 'active', ottoOnline: true },
          { id: 'smart-pm', username: 'smart.pm', name: '王敏', role: '项目经理', department: '研发中心', departmentId: 'smart-rd', positionId: 'smart-pm-pos', positionTitle: '项目经理', avatarUrl: null, isAdmin: false, status: 'active', ottoOnline: true },
          { id: 'smart-engineer', username: 'smart.engineer', name: '周工', role: '工程师', department: '研发中心', departmentId: 'smart-rd', positionId: 'smart-engineer-pos', positionTitle: '工程师', avatarUrl: null, isAdmin: false, status: 'active', ottoOnline: false },
        ];
        return Promise.resolve({
          organization: { id: 'preview-tenant-smart', name: '宏创智能制造', status: 'active', industry: '智能制造', parkId: 'preview-park', createdAt: previewAccount.createdAt },
          members,
          employeeCount: members.length,
          structure: [
            { id: 'smart-management', organizationId: 'preview-tenant-smart', name: '管理层', parentDepartmentId: null, memberCount: 1, positions: [{ id: 'smart-owner-pos', organizationId: 'preview-tenant-smart', departmentId: 'smart-management', title: '企业负责人', roleMapping: 'enterprise_admin', createdAt: '', updatedAt: '' }], createdAt: '', updatedAt: '' },
            { id: 'smart-rd', organizationId: 'preview-tenant-smart', name: '研发中心', parentDepartmentId: null, memberCount: 2, positions: [{ id: 'smart-pm-pos', organizationId: 'preview-tenant-smart', departmentId: 'smart-rd', title: '项目经理', roleMapping: 'department_admin', createdAt: '', updatedAt: '' }, { id: 'smart-engineer-pos', organizationId: 'preview-tenant-smart', departmentId: 'smart-rd', title: '工程师', roleMapping: 'member', createdAt: '', updatedAt: '' }], createdAt: '', updatedAt: '' },
            { id: 'smart-product', organizationId: 'preview-tenant-smart', name: '产品组', parentDepartmentId: 'smart-rd', memberCount: 0, positions: [], createdAt: '', updatedAt: '' },
          ],
          park: { id: 'preview-park', name: '宏创园区', brandName: '宏创园区服务', adminOrganizationId: 'preview-park-admin', status: 'active', createdAt: '', updatedAt: '', isAdminOrganization: false },
          features,
        });
      }
      return Promise.resolve({
        organization: { id: previewAccount.organizationId, name: previewAccount.organizationName, status: 'active', industry: '园区运营服务', parkId: 'preview-park', createdAt: previewAccount.createdAt },
        members: [previewAccount],
        employeeCount: 1,
        structure: [{ id: 'preview-park-dept', organizationId: previewAccount.organizationId, name: '园区管理部', parentDepartmentId: null, memberCount: 1, positions: [], createdAt: '', updatedAt: '' }],
        park: { id: 'preview-park', name: '宏创园区', brandName: '宏创园区服务', adminOrganizationId: previewAccount.organizationId, status: 'active', createdAt: '', updatedAt: '', isAdminOrganization: true },
        features,
      });
    },
    enterpriseParkTenants: () => Promise.resolve(previewTenantOrganizations),
    enterprisePublicProfile: () => Promise.resolve({ ...previewPublicProfile }),
    enterprisePublicProfileUpdate: (input: Record<string, unknown>) => {
      previewPublicProfile = {
        ...previewPublicProfile,
        ...input,
        updatedAt: new Date().toISOString(),
      } as typeof previewPublicProfile;
      return Promise.resolve({ ...previewPublicProfile });
    },
    enterpriseParkStarMap: () => {
      const nodes = [
        previewPublicProfile,
        {
          organizationId: 'preview-tenant-smart',
          organizationName: '宏创智能制造',
          summary: '提供自动化产线、工业视觉与设备改造。',
          website: 'https://example.com/smart',
          industryTags: ['智能制造'],
          productsServices: ['智能制造解决方案', '自动化产线改造'],
          capabilities: ['工业视觉', '设备集成'],
          cooperationNeeds: ['企业数字化服务'],
          publicContact: '商务合作 smart@example.com',
          isPublic: true,
          updatedAt: new Date().toISOString(),
        },
        {
          organizationId: 'preview-tenant-digital',
          organizationName: '北辰数字科技',
          summary: '企业数字化和数据平台服务商。',
          website: 'https://example.com/digital',
          industryTags: ['软件与信息服务'],
          productsServices: ['企业数字化服务'],
          capabilities: ['园区数字化运营', '数据平台建设'],
          cooperationNeeds: ['智能制造解决方案'],
          publicContact: '合作邮箱 digital@example.com',
          isPublic: true,
          updatedAt: new Date().toISOString(),
        },
      ];
      return Promise.resolve({
        parkId: 'preview-park',
        parkName: '北控宏创科技园',
        currentOrganizationId: previewAccount.organizationId,
        generatedAt: new Date().toISOString(),
        nodes,
        edges: [
          {
            id: 'preview-park-admin--preview-tenant-smart',
            sourceOrganizationId: previewAccount.organizationId,
            targetOrganizationId: 'preview-tenant-smart',
            strength: 'promising',
            ruleConfidence: 0.78,
            evidence: [
              '宏创园区管理方公开需求“智能制造解决方案”与宏创智能制造公开产品/服务“智能制造解决方案”存在互补',
            ],
            unverifiedQuestions: ['双方需核实交付范围、产能、时间与商务条件。'],
          },
          {
            id: 'preview-park-admin--preview-tenant-digital',
            sourceOrganizationId: previewAccount.organizationId,
            targetOrganizationId: 'preview-tenant-digital',
            strength: 'strong',
            ruleConfidence: 0.86,
            evidence: [
              '宏创园区管理方公开需求“企业数字化服务”与北辰数字科技公开产品/服务“企业数字化服务”存在互补',
              '北辰数字科技公开需求“智能制造解决方案”与宏创园区管理方公开合作需求存在业务联动线索',
            ],
            unverifiedQuestions: ['公开资料是否仍然有效，需由企业联系人确认。'],
          },
        ],
      });
    },
    enterpriseMessagesList: (peerAccountId: string) => {
      // 与真实后端一致：拉取会话消息即标记该 peer 已读，下轮轮询未读清零
      previewUnread.delete(peerAccountId);
      return Promise.resolve(previewDirectMessages.get(peerAccountId) ?? []);
    },
    enterpriseMessageSend: (
      peerAccountId: string,
      content: string,
      attachments: Array<Record<string, unknown>> = [],
    ) => {
      const message = {
        id: id('preview-message'),
        senderAccountId: previewAccount.id,
        recipientAccountId: peerAccountId,
        content,
        createdAt: new Date().toISOString(),
        readAt: null,
        attachments: attachments.map((attachment) => ({
          id: id('preview-attachment'),
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          size: attachment.size,
        })),
      };
      previewDirectMessages.set(peerAccountId, [
        ...(previewDirectMessages.get(peerAccountId) ?? []),
        message,
      ]);
      return Promise.resolve(message);
    },
    // 工作日志：预览演示数据（仅浏览器预览注入，Electron 下由 server 提供真实数据）
    workLogToday: () => {
      const today = new Date().toISOString().slice(0, 10);
      return Promise.resolve({
        date: today,
        summary: '预览演示：今日完成 2 项成果，共 5 次操作。',
        totalActions: 5,
        workResults: 2,
      });
    },
    workLogRecent: (days = 30) => {
      const today = new Date();
      const iso = (offset: number) => new Date(today.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
      void days;
      return Promise.resolve([
        {
          date: iso(0),
          entries: [
            { time: '09:30', action: '整理园区报修工单并分派', taskTitle: '工单分派', entryType: 'work_result', success: true },
            { time: '10:15', action: '与演示同事沟通会议室预订流程', entryType: 'note', success: true },
            { time: '11:00', action: '输出企业部署交付清单初稿', taskTitle: '交付清单', entryType: 'work_result', success: true },
            { time: '14:20', action: '查看企业知识库新增条目', entryType: 'note', success: true },
            { time: '16:40', action: '预约明日 10:00 中型会议室', entryType: 'note', success: true },
          ],
        },
        {
          date: iso(1),
          entries: [
            { time: '10:00', action: '完成园区入驻企业回访', taskTitle: '企业回访', entryType: 'work_result', success: true },
            { time: '15:30', action: '更新排班表', entryType: 'note', success: true },
          ],
        },
        { date: iso(2), entries: [{ time: '09:10', action: '整理周报素材', entryType: 'note', success: true }] },
      ]);
    },
    workLogReport: () => Promise.resolve({
      ok: false,
      path: '',
      message: '浏览器预览不落地文件；正式版会生成 Markdown 总结并保存到本地。',
    }),
    enterpriseParkView: () => Promise.resolve({
      id: 'preview-park',
      name: '北控宏创科技园',
      slug: 'browser-preview',
      brandName: '北控宏创园区服务',
      adminOrganizationId: previewAccount.organizationId,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isAdminOrganization: true,
      services: [
        { parkId: 'preview-park', id: 'renovation', name: '装修管理', enabled: true, config: {}, updatedAt: new Date().toISOString() },
        { parkId: 'preview-park', id: 'parking', name: '停车办理', enabled: true, config: {}, updatedAt: new Date().toISOString() },
        { parkId: 'preview-park', id: 'network-phone', name: '网络与固话', enabled: true, config: {}, updatedAt: new Date().toISOString() },
        { parkId: 'preview-park', id: 'meeting-room', name: '会议室预约', enabled: true, config: {}, updatedAt: new Date().toISOString() },
        { parkId: 'preview-park', id: 'electric-card', name: '电卡服务', enabled: true, config: {}, updatedAt: new Date().toISOString() },
        { parkId: 'preview-park', id: 'repair', name: '物业报修', enabled: true, config: {}, updatedAt: new Date().toISOString() },
        { parkId: 'preview-park', id: 'vehicle-visit', name: '车辆与访客', enabled: true, config: {}, updatedAt: new Date().toISOString() },
        { parkId: 'preview-park', id: 'announcement', name: '园区公告', enabled: true, config: {}, updatedAt: new Date().toISOString() },
        { parkId: 'preview-park', id: 'satisfaction', name: '满意度调查', enabled: true, config: {}, updatedAt: new Date().toISOString() },
      ],
      tenantAddress: '科技大厦 A 座',
      tenantRoomNumber: '1203 室',
    }),
    enterpriseParkCarpoolGet: () => Promise.resolve(structuredClone(previewCarpoolState)),
    enterpriseParkCarpoolSearchPlaces: (query: string) => Promise.resolve([{
      id: `preview-place-${query}`,
      label: query,
      address: query.includes('园区') ? '七北路与宏福大道交叉口' : '北京市昌平区',
      district: '昌平区',
      coordinate: query.includes('园区')
        ? { longitude: 116.372, latitude: 40.106 }
        : { longitude: 116.317, latitude: 40.071 },
    }]),
    enterpriseParkCarpoolPublish: (input: Record<string, unknown>) => {
      const now = new Date().toISOString();
      const intent = {
        id: 'preview-carpool-intent', accountId: previewAccount.id,
        organizationId: previewAccount.organizationId,
        organizationName: previewAccount.organizationName,
        displayName: previewAccount.name, parkId: 'preview-park', ...input,
        route: { provider: 'preview-map', distanceMeters: 12_400, durationSeconds: 1_900, polyline: [] },
        status: 'active', lastConfirmedAt: now, expiresAt: now,
        createdAt: now, updatedAt: now,
      };
      previewCarpoolState = {
        ...previewCarpoolState,
        currentIntent: intent,
        matches: [{
          intentId: 'preview-carpool-peer', displayName: '李某',
          organizationName: '宏创智能制造', verifiedParkMember: true,
          departureTime: input.departureTime, timeDifferenceMinutes: 10,
          overlapPercent: 88, commonDistanceMeters: 10_500,
          compatibleModes: ['current_rides_candidate_vehicle'],
          originArea: '宏创园区南门', destinationArea: '回龙观',
          freshness: 'just_updated',
          explanation: '路线同向共同路段约 10.5 公里，路线重合度约 88%，出发时间相差 10 分钟。',
        }],
        generatedAt: now,
      };
      return Promise.resolve(structuredClone(intent));
    },
    enterpriseParkCarpoolRefresh: () => Promise.resolve(structuredClone(previewCarpoolState)),
    enterpriseParkCarpoolStop: () => {
      const current = previewCarpoolState.currentIntent as Record<string, unknown> | null;
      const intent = current ? { ...current, status: 'paused', updatedAt: new Date().toISOString() } : null;
      previewCarpoolState = { ...previewCarpoolState, currentIntent: intent, matches: [] };
      return Promise.resolve(structuredClone(intent));
    },
    enterpriseTicketList: () => Promise.resolve(previewTickets),
    enterpriseParkPublications: () => Promise.resolve(previewParkPublications.map((item) => ({ ...item }))),
    enterpriseParkPublicationRead: (publicationId: string) => {
      const next = previewParkPublications.find((item) => item.id === publicationId);
      if (!next) return Promise.reject(new Error('园区通知不存在'));
      next.readAt = new Date().toISOString();
      next.readCount = Number(next.readCount ?? 0) + 1;
      return Promise.resolve({ ...next });
    },
    enterpriseParkSurveySubmit: (publicationId: string, responseData: Record<string, string>) => {
      const next = previewParkPublications.find((item) => item.id === publicationId);
      if (!next || next.kind !== 'satisfaction') return Promise.reject(new Error('满意度调查不存在'));
      const wasUnread = !next.readAt;
      next.submittedAt = new Date().toISOString();
      next.responseData = { ...responseData };
      next.readAt = next.readAt ?? new Date().toISOString();
      next.readCount = Number(next.readCount ?? 0) + (wasUnread ? 1 : 0);
      return Promise.resolve({ ...next });
    },
    enterpriseParkResources: () => Promise.resolve({
      settings: {
        parkingTotal: 180,
        parkingNote: '固定车位需由客服确认，新能源车位优先分配。',
        updatedAt: new Date().toISOString(),
      },
      meetingRooms: [
        {
          id: 'preview-room-medium',
          name: '中会议室',
          location: '位置待园区管理员补充',
          capacity: 30,
          priceHalfDay: 400,
          equipment: ['投屏', '视频会议', '白板'],
          imageUrl: null,
          openingHours: '工作日 09:00–23:00',
          enabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'preview-room-large',
          name: '大会议室',
          location: '位置待园区管理员补充',
          capacity: 50,
          priceHalfDay: 500,
          equipment: ['投屏', '视频会议', '白板'],
          imageUrl: null,
          openingHours: '工作日 09:00–23:00',
          enabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'preview-room-auditorium',
          name: '报告厅',
          location: '位置待园区管理员补充',
          capacity: 80,
          priceHalfDay: 800,
          equipment: ['投屏', '视频会议', '白板'],
          imageUrl: null,
          openingHours: '工作日 09:00–23:00',
          enabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      meetingSlots: previewMeetingSlots,
    }),
    enterpriseTicketSubmit: (input: Record<string, unknown>) => {
      const now = new Date().toISOString();
      const serviceId = String(input.serviceId || 'repair');
      const formData =
        input.formData && typeof input.formData === 'object'
          ? (input.formData as Record<string, unknown>)
          : {};
      if (serviceId === 'meeting-room') {
        const selectedSlots = previewMeetingSlots.filter(
          (item) =>
            item.roomId === formData.roomId &&
            item.date === formData.date &&
            String(item.slotKey) >= String(formData.startTime) &&
            String(item.slotKey) < String(formData.endTime),
        );
        if (
          !selectedSlots.length ||
          selectedSlots.some((slot) => slot.status !== 'available')
        ) {
          const booked = selectedSlots.some((slot) => slot.status === 'booked');
          return Promise.reject(
            new Error(
              booked ? '该时段刚刚已被预约，请选择其他时段' : '该时段暂未开放',
            ),
          );
        }
        for (const slot of selectedSlots) {
          slot.status = 'booked';
          slot.updatedAt = now;
        }
      }
      previewApplicationSequence += 1;
      const ticket = {
        id: id('preview-ticket'),
        applicationNumber: `${parkISODate().replace(/-/g, '')}${String(previewApplicationSequence).padStart(3, '0')}`,
        serviceId,
        title: String(input.title || '园区服务申请'),
        description: String(input.description || ''),
        formData,
        targetTags: serviceId === 'repair' ? ['维修工作人员'] : ['客服人员'],
        status: serviceId === 'repair' ? '待接单' : '待派单',
        category: input.category ? String(input.category) : null,
        location: input.location ? String(input.location) : null,
        urgency: input.urgency ? String(input.urgency) : null,
        contact: input.contact ? String(input.contact) : null,
        contactPhone: input.contactPhone ? String(input.contactPhone) : null,
        responseType: null,
        responseText: null,
        responseAt: null,
        createdAt: now,
        updatedAt: now,
        creator: {
          id: previewAccount.id,
          name: previewAccount.name,
          username: previewAccount.username,
        },
        recipientCount: serviceId === 'repair' ? 1 : 2,
        recipients:
          serviceId === 'repair'
            ? [{ id: 'preview-repairer', name: '维修工作人员' }]
            : [
                { id: 'preview-cs-1', name: '客服一组' },
                { id: 'preview-cs-2', name: '客服二组' },
              ],
        deliveryStatus: serviceId === 'renovation' ? '已投递客服部' : '已投递',
        readAt: null,
        creatorUpdateAt: null,
        creatorUpdateReadAt: null,
        isCreator: true,
        isRecipient: false,
        notifications: [],
      };
      previewTickets = [ticket, ...previewTickets];
      return Promise.resolve(ticket);
    },
    enterpriseTicketRead: (ticketId: string) => {
      const ticket =
        previewTickets.find((item) => item.id === ticketId) ?? null;
      if (!ticket) return Promise.reject(new Error('申请单不存在'));
      const viewed = {
        ...ticket,
        creatorUpdateReadAt: new Date().toISOString(),
        readAt: ticket.isRecipient ? new Date().toISOString() : ticket.readAt,
      };
      previewTickets = previewTickets.map((item) =>
        item.id === ticketId ? viewed : item,
      );
      return Promise.resolve(viewed);
    },
    enterpriseTicketAction: (ticketId: string) => {
      const ticket =
        previewTickets.find((item) => item.id === ticketId) ?? null;
      return ticket
        ? Promise.resolve(ticket)
        : Promise.reject(new Error('申请单不存在'));
    },
    enterpriseUsageRecord: () => Promise.resolve({ recorded: false }),
    enterpriseUsageProfile: (periodDays = 30) => Promise.resolve({
      accountId: previewAccount.id,
      periodDays,
      source: 'client_reported',
      inputTokens: 18_400,
      outputTokens: 9_600,
      totalTokens: 28_000,
      requestCount: 42,
      averageTokensPerRequest: 667,
      lastUsedAt: new Date().toISOString(),
      byModel: [{
        model: 'preview-model', inputTokens: 18_400, outputTokens: 9_600,
        totalTokens: 28_000, requestCount: 42,
      }],
      daily: [{
        date: parkISODate(new Date()), inputTokens: 18_400, outputTokens: 9_600,
        totalTokens: 28_000, requestCount: 42,
      }],
    }),
    enterpriseKnowledgeRecord: () =>
      Promise.resolve({ status: 'exists', added: false }),
    enterpriseKnowledgeList: () => Promise.resolve([]),
    enterpriseKnowledgeReview: () =>
      Promise.reject(new Error('预览模式不支持知识审核')),
    enterpriseKnowledgeRevise: () =>
      Promise.reject(new Error('预览模式不支持知识修订')),
    enterpriseKnowledgeRevisions: () => Promise.resolve([]),
    enterpriseKnowledgeEvidence: () => Promise.resolve([]),
    policyIntelligenceGet: () => Promise.resolve(structuredClone(previewPolicyState)),
    policyIntelligenceConfigure: (input: { enabled: boolean; profile?: Record<string, unknown> }) => {
      previewPolicyState = { ...previewPolicyState, enabled: input.enabled, profile: { ...previewPolicyState.profile, ...(input.profile ?? {}) } };
      return Promise.resolve(structuredClone(previewPolicyState));
    },
    policyIntelligenceUpdateProfile: (input: { patch: Record<string, unknown> }) => {
      previewPolicyState = { ...previewPolicyState, profile: { ...previewPolicyState.profile, ...input.patch } };
      return Promise.resolve(structuredClone(previewPolicyState));
    },
    policyIntelligenceSync: () => Promise.resolve(structuredClone(previewPolicyState)),
  };

  previewWindow.otto = new Proxy(bridge, {
    get(target, key) {
      return key in target
        ? target[key as string]
        : () => Promise.resolve(null);
    },
  });
}
