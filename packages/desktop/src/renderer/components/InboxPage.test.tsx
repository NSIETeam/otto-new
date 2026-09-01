/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EnterpriseAccount,
  EnterpriseFederationContact,
  EnterpriseRepairTicket,
  EnterpriseUnreadMessageNotification,
} from '../../preload/index.js';
import { InboxPage } from './InboxPage.js';

const account: EnterpriseAccount = {
  id: 'member-1',
  organizationId: 'organization-1',
  organizationName: '测试企业',
  employeeId: null,
  username: 'member-1',
  phone: null,
  name: '测试成员',
  role: '成员',
  department: '研发部',
  positionId: null,
  positionTitle: '工程师',
  isAdmin: false,
  status: 'active',
  tags: [],
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:00:00.000Z',
};

function parkTicket(
  overrides: Partial<EnterpriseRepairTicket> = {},
): EnterpriseRepairTicket {
  return {
    id: 'park-ticket-1',
    applicationNumber: 'HC-20260901-0001',
    serviceId: 'repair',
    title: '会议室照明故障',
    description: '三层 301 会议室照明无法打开',
    formData: {},
    targetTags: [],
    status: '维修中',
    category: '电气',
    location: '3F-301',
    urgency: '普通',
    contact: '测试成员',
    contactPhone: null,
    responseType: '办理进展',
    responseText: '工程人员已到场，正在更换灯具。',
    responseAt: '2026-09-01 04:32:00',
    createdAt: '2026-09-01 04:00:00',
    updatedAt: '2026-09-01 04:32:00',
    creator: { id: account.id, name: account.name, username: account.username },
    recipientCount: 1,
    recipients: [{ id: 'staff-1', name: '园区客服小张' }],
    creatorUpdateAt: '2026-09-01 04:32:00',
    creatorUpdateReadAt: null,
    isCreator: true,
    isRecipient: false,
    history: [
      {
        id: 'history-created',
        action: 'created',
        statusBefore: null,
        statusAfter: '待派单',
        responseType: null,
        responseText: null,
        createdAt: '2026-09-01 04:00:00',
        actor: { id: account.id, name: account.name },
      },
      {
        id: 'history-response',
        action: 'respond',
        statusBefore: '维修中',
        statusAfter: '维修中',
        responseType: '办理进展',
        responseText: '工程人员已到场，正在更换灯具。',
        createdAt: '2026-09-01 04:32:00',
        actor: { id: 'staff-1', name: '园区客服小张' },
      },
    ],
    notifications: [],
    ...overrides,
  };
}

beforeEach(() => {
  (window as unknown as { otto: unknown }).otto = {
    enterpriseMessagesUnread: vi.fn(async () => (
      undefined as unknown as EnterpriseUnreadMessageNotification[]
    )),
    enterpriseOrganizationView: vi.fn(async () => ({ members: [] })),
    enterpriseFederationContacts: vi.fn(async () => []),
    enterpriseFederationMessagesList: vi.fn(async () => []),
    enterpriseFederationMessageSend: vi.fn(async () => ({
      id: 'federation-a2a-proposal',
      senderAccountId: account.id,
      recipientAccountId: 'deployment-b:remote-account',
      content: 'encrypted proposal placeholder',
      createdAt: '2026-08-12T00:02:00.000Z',
      readAt: null,
      federated: true,
      contactId: 'contact-remote',
      federationMessageType: 'chat.message',
      direction: 'outbound',
      deliveryStatus: 'queued',
      trustState: 'verified',
    })),
    enterpriseFederationContactVerification: vi.fn(async () => ({
      safetyNumber: '1234567890123456',
      qrPayload: 'OTTO_E2EE_VERIFY_V1:test',
      deviceFingerprints: ['a'.repeat(64), 'b'.repeat(64)],
      verifiedAt: null,
    })),
    enterpriseFederationAttachmentSave: vi.fn(async () => ({
      id: 'fattachment-one',
      fileName: 'evidence.pdf',
      mimeType: 'application/pdf',
      size: 1024,
      path: 'D:\\Downloads\\evidence.pdf',
    })),
    enterpriseTicketList: vi.fn(async () => []),
    enterpriseTicketRead: vi.fn(async () => parkTicket()),
    enterpriseTicketAction: vi.fn(async () => parkTicket()),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('InboxPage response hardening', () => {
  it('keeps the inbox usable when an older bridge returns no notification array', async () => {
    render(
      <InboxPage
        enterpriseAccount={account}
        effectiveDirectMessages
        effectiveAtoa
        onBack={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('暂无消息')).toBeTruthy();
    });
    expect(screen.getByRole('region', { name: '我的消息' })).toBeTruthy();
  });

  it('confirms a direct-message read only after the conversation load succeeds', async () => {
    const peer = {
      id: 'member-2',
      username: 'member-2',
      name: '同事二',
      role: '成员',
      department: '研发部',
      positionId: null,
      positionTitle: '工程师',
      isAdmin: false,
      status: 'active' as const,
    };
    let resolveMessages!: (messages: []) => void;
    const enterpriseMessagesList = vi.fn(() => new Promise<[]>(
      (resolve) => { resolveMessages = resolve; },
    ));
    const onMessageRead = vi.fn();
    Object.assign(window.otto, {
      enterpriseMessagesUnread: vi.fn(async () => [{
        id: 'message-1',
        source: 'enterprise' as const,
        title: '同事二发来消息',
        senderAccountId: peer.id,
        senderName: peer.name,
        preview: '请查看项目进度',
        createdAt: '2026-08-27T12:00:00.000Z',
      }]),
      enterpriseOrganizationView: vi.fn(async () => ({ members: [peer] })),
      enterpriseMessagesList,
    });

    render(
      <InboxPage
        enterpriseAccount={account}
        effectiveDirectMessages
        enterpriseUnreadCounts={{ 'enterprise:message:member-2': 1 }}
        onMessageRead={onMessageRead}
        onBack={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByRole('listitem', { name: /同事二/ }));
    await waitFor(() => expect(enterpriseMessagesList).toHaveBeenCalledWith('member-2'));
    expect(onMessageRead).not.toHaveBeenCalled();

    resolveMessages([]);
    await waitFor(() => expect(onMessageRead).toHaveBeenCalledWith('member-2'));
  });

  it('opens a federated E2EE conversation from the same contact list', async () => {
    const contact: EnterpriseFederationContact = {
      id: 'contact-remote',
      identity: 'deployment-b:remote-account',
      remoteDeploymentId: 'deployment-b',
      remotePrincipalId: 'remote-account',
      displayName: '远程同事',
      deploymentDisplayName: '北京私有部署',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      lastMessageAt: '2026-08-12T00:01:00.000Z',
      unreadCount: 1,
      trustState: 'unverified',
      keyFingerprint: 'b'.repeat(64),
    };
    const bridge = window.otto as unknown as Record<string, ReturnType<typeof vi.fn>>;
    bridge.enterpriseFederationContacts.mockResolvedValue([contact]);
    bridge.enterpriseFederationMessagesList.mockResolvedValue([{
      id: 'federation-message-1',
      senderAccountId: contact.identity,
      recipientAccountId: account.id,
      content: '跨服务器消息正文',
      createdAt: '2026-08-12T00:01:00.000Z',
      readAt: null,
      attachments: [{
        id: 'fattachment-one',
        fileName: 'evidence.pdf',
        mimeType: 'application/pdf',
        size: 1024,
      }],
      e2ee: true,
      e2eeProtocol: 'device-envelope-v1',
      contentType: 'message',
      inReplyToMessageId: null,
      federated: true,
      contactId: contact.id,
      direction: 'inbound',
      deliveryStatus: 'received',
      trustState: 'unverified',
    }]);

    render(
      <InboxPage
        enterpriseAccount={account}
        effectiveDirectMessages
        effectiveAtoa
        onBack={() => undefined}
      />,
    );

    const contactButton = await screen.findByRole('listitem', { name: /远程同事/ });
    fireEvent.click(contactButton);

    await waitFor(() => {
      expect(screen.getByText('跨服务器消息正文')).toBeTruthy();
    });
    expect(screen.getByText('端到端加密安全号码')).toBeTruthy();
    expect(screen.getByText('1234 5678 9012 3456')).toBeTruthy();
    expect(screen.getByText('未核验')).toBeTruthy();
    expect(screen.getByText('evidence.pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(bridge.enterpriseFederationAttachmentSave).toHaveBeenCalledWith(
        contact.id,
        'federation-message-1',
        'fattachment-one',
        'evidence.pdf',
      );
    });
  });

  it('only lets a verified contact receive an encrypted A2A proposal', async () => {
    const contact: EnterpriseFederationContact = {
      id: 'contact-remote',
      identity: 'deployment-b:remote-account',
      remoteDeploymentId: 'deployment-b',
      remotePrincipalId: 'remote-account',
      displayName: '远程同事',
      deploymentDisplayName: '北京私有部署',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      lastMessageAt: null,
      unreadCount: 0,
      trustState: 'verified',
      keyFingerprint: 'b'.repeat(64),
    };
    const bridge = window.otto as unknown as Record<string, ReturnType<typeof vi.fn>>;
    bridge.enterpriseFederationContacts.mockResolvedValue([contact]);

    render(
      <InboxPage
        enterpriseAccount={account}
        effectiveDirectMessages
        effectiveAtoa
        onBack={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByRole('listitem', { name: /远程同事/ }));
    const askButton = await screen.findByRole('button', { name: '询问对方 Otto' });
    expect((askButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox', { name: '回复消息' }), {
      target: { value: '你明天下午是否方便开会？' },
    });
    expect((askButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(askButton);

    await waitFor(() => {
      expect(bridge.enterpriseFederationMessageSend).toHaveBeenCalledTimes(1);
    });
    const [contactId, content] = bridge.enterpriseFederationMessageSend.mock.calls[0]!;
    expect(contactId).toBe(contact.id);
    expect(content).toMatch(/^OTTO_ATOA_REQUEST /u);
    expect(content).toContain('你明天下午是否方便开会？');
  });

  it('私聊 effective=false 时 fail closed，不请求本企业或跨服务器消息接口', async () => {
    const bridge = window.otto as unknown as Record<string, ReturnType<typeof vi.fn>>;

    render(
      <InboxPage
        enterpriseAccount={account}
        effectiveDirectMessages={false}
        onBack={() => undefined}
      />,
    );

    expect(await screen.findByText('企业私聊未启用或当前服务器未授权，不会请求企业消息数据。')).toBeTruthy();
    expect(bridge.enterpriseMessagesUnread).not.toHaveBeenCalled();
    expect(bridge.enterpriseOrganizationView).not.toHaveBeenCalled();
    expect(bridge.enterpriseFederationContacts).not.toHaveBeenCalled();
    expect(bridge.enterpriseFederationMessagesList).not.toHaveBeenCalled();
    expect(bridge.enterpriseTicketList).not.toHaveBeenCalled();
  });

  it('keeps local baseline messaging without probing unentitled Federation', async () => {
    const bridge = window.otto as unknown as Record<string, ReturnType<typeof vi.fn>>;

    render(
      <InboxPage
        enterpriseAccount={account}
        baselineDirectMessagesAvailable
        baselineEnterpriseTreeAvailable
        effectiveDirectMessages={false}
        onBack={() => undefined}
      />,
    );

    expect(await screen.findByText('暂无消息')).toBeTruthy();
    expect(bridge.enterpriseMessagesUnread).toHaveBeenCalled();
    expect(bridge.enterpriseOrganizationView).toHaveBeenCalled();
    expect(bridge.enterpriseFederationContacts).not.toHaveBeenCalled();
    expect(screen.queryByTitle('复制我的跨服务器联系码')).toBeNull();
    expect(screen.queryByTitle('添加跨服务器联系人')).toBeNull();
  });

  it('does not load the member directory when its baseline switch is off', async () => {
    const bridge = window.otto as unknown as Record<string, ReturnType<typeof vi.fn>>;

    render(
      <InboxPage
        enterpriseAccount={account}
        baselineDirectMessagesAvailable
        baselineEnterpriseTreeAvailable={false}
        effectiveDirectMessages={false}
        onBack={() => undefined}
      />,
    );

    expect(await screen.findByText('暂无消息')).toBeTruthy();
    expect(bridge.enterpriseMessagesUnread).toHaveBeenCalled();
    expect(bridge.enterpriseOrganizationView).not.toHaveBeenCalled();
  });

  it('A2A effective=false 时不显示跨服务器 Otto 询问入口，也不会发送 A2A 请求', async () => {
    const contact: EnterpriseFederationContact = {
      id: 'contact-remote',
      identity: 'deployment-b:remote-account',
      remoteDeploymentId: 'deployment-b',
      remotePrincipalId: 'remote-account',
      displayName: '远程同事',
      deploymentDisplayName: '北京私有部署',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      lastMessageAt: null,
      unreadCount: 0,
      trustState: 'verified',
      keyFingerprint: 'b'.repeat(64),
    };
    const bridge = window.otto as unknown as Record<string, ReturnType<typeof vi.fn>>;
    bridge.enterpriseFederationContacts.mockResolvedValue([contact]);

    render(
      <InboxPage
        enterpriseAccount={account}
        effectiveDirectMessages
        effectiveAtoa={false}
        onBack={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByRole('listitem', { name: /远程同事/ }));
    await screen.findByText('1234 5678 9012 3456');
    expect(screen.queryByRole('button', { name: '询问对方 Otto' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '回复消息' }), {
      target: { value: '请让对方 Otto 回答' },
    });
    expect(bridge.enterpriseFederationMessageSend).not.toHaveBeenCalled();
  });

  it('将客服办理回复作为持久会话展示，读完退出后仍然存在', async () => {
    let persistedTicket = parkTicket();
    const bridge = window.otto as unknown as Record<string, ReturnType<typeof vi.fn>>;
    bridge.enterpriseTicketList.mockImplementation(async () => [persistedTicket]);
    bridge.enterpriseTicketRead.mockImplementation(async () => {
      persistedTicket = {
        ...persistedTicket,
        creatorUpdateReadAt: persistedTicket.creatorUpdateAt,
      };
      return persistedTicket;
    });
    const onParkTicketRead = vi.fn();

    const firstView = render(
      <InboxPage
        enterpriseAccount={account}
        effectiveDirectMessages={false}
        effectiveParkService
        onParkTicketRead={onParkTicketRead}
        onBack={() => undefined}
      />,
    );

    const unreadConversation = await screen.findByRole('listitem', {
      name: /物业报修客服，申请编号 HC-20260901-0001，1 条未读/u,
    });
    fireEvent.click(unreadConversation);

    expect(await screen.findByText('工程人员已到场，正在更换灯具。')).toBeTruthy();
    expect(screen.getByText(/客服的办理回复会自动同步/u)).toBeTruthy();
    await waitFor(() => {
      expect(bridge.enterpriseTicketRead).toHaveBeenCalledWith('park-ticket-1');
      expect(onParkTicketRead).toHaveBeenCalledWith('park-ticket-1');
      expect(screen.getByRole('listitem', {
        name: /物业报修客服，申请编号 HC-20260901-0001，0 条未读/u,
      })).toBeTruthy();
    });

    firstView.unmount();
    render(
      <InboxPage
        enterpriseAccount={account}
        effectiveDirectMessages={false}
        effectiveParkService
        onBack={() => undefined}
      />,
    );

    expect(await screen.findByRole('listitem', {
      name: /物业报修客服，申请编号 HC-20260901-0001，0 条未读/u,
    })).toBeTruthy();
    expect(bridge.enterpriseTicketList).toHaveBeenCalledTimes(2);
  });

  it('申请进入待验收后可以在客服会话中确认办理完成', async () => {
    const awaitingAcceptance = parkTicket({
      status: '待验收',
      creatorUpdateReadAt: '2026-09-01 04:32:00',
    });
    const completed = parkTicket({
      ...awaitingAcceptance,
      status: '已完成',
      history: [
        ...(awaitingAcceptance.history ?? []),
        {
          id: 'history-confirm',
          action: 'confirm',
          statusBefore: '待验收',
          statusAfter: '已完成',
          responseType: null,
          responseText: null,
          createdAt: '2026-09-01 04:40:00',
          actor: { id: account.id, name: account.name },
        },
      ],
    });
    const bridge = window.otto as unknown as Record<string, ReturnType<typeof vi.fn>>;
    bridge.enterpriseTicketList.mockResolvedValue([awaitingAcceptance]);
    bridge.enterpriseTicketAction.mockResolvedValue(completed);

    render(
      <InboxPage
        enterpriseAccount={account}
        effectiveDirectMessages={false}
        effectiveParkService
        onBack={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByRole('listitem', { name: /物业报修客服/u }));
    fireEvent.click(await screen.findByRole('button', { name: '确认办理完成' }));
    await waitFor(() => {
      expect(bridge.enterpriseTicketAction).toHaveBeenCalledWith(
        'park-ticket-1',
        { action: 'confirm' },
      );
      expect(screen.getByText('你已确认验收')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: '确认办理完成' })).toBeNull();
  });

  it('只把七类可办理园区服务收进客服会话，不混入公告、问卷或工作人员待办', async () => {
    const serviceIds = [
      'renovation',
      'parking',
      'network-phone',
      'meeting-room',
      'electric-card',
      'repair',
      'vehicle-visit',
      'announcement',
      'satisfaction',
    ];
    const bridge = window.otto as unknown as Record<string, ReturnType<typeof vi.fn>>;
    bridge.enterpriseTicketList.mockResolvedValue([
      ...serviceIds.map((serviceId, index) => parkTicket({
        id: `ticket-${serviceId}`,
        applicationNumber: `HC-${index}`,
        serviceId,
        creatorUpdateAt: null,
        creatorUpdateReadAt: null,
        history: [],
      })),
      parkTicket({
        id: 'ticket-staff-only',
        applicationNumber: 'HC-STAFF',
        creator: { id: 'other-member', name: '其他申请人', username: 'other-member' },
        isCreator: false,
        isRecipient: true,
      }),
    ]);

    render(
      <InboxPage
        enterpriseAccount={account}
        effectiveDirectMessages={false}
        effectiveParkService
        onBack={() => undefined}
      />,
    );

    await screen.findByText('园区客服');
    const conversations = screen.getAllByRole('listitem');
    expect(conversations).toHaveLength(7);
    expect(screen.getByRole('listitem', { name: /装修管理客服/u })).toBeTruthy();
    expect(screen.getByRole('listitem', { name: /车辆与访客客服/u })).toBeTruthy();
    expect(screen.queryByRole('listitem', { name: /公告/u })).toBeNull();
    expect(screen.queryByRole('listitem', { name: /满意度/u })).toBeNull();
    expect(screen.queryByRole('listitem', { name: /HC-STAFF/u })).toBeNull();
  });
});
