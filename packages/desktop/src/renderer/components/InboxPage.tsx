/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

/**
 * 我的消息（导航一级入口）。
 *
 * 企业私信、跨服务器联系人和当前申请人发起的七类园区服务工单使用
 * 同一份会话目录，按最后动态时间混排并共享未读筛选。客服的受理、
 * 回复、转交和办结作为可持久回看的办理时间线。园区公告和满意度调查
 * 是发布型内容，仍由园区服务模块展示，不伪装成一对一客服会话。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  EnterpriseAccount,
  EnterpriseDirectMessage,
  EnterpriseDirectMessageAttachmentUpload,
  EnterpriseFederationContact,
  EnterpriseOrganizationView,
  EnterpriseRepairTicket,
  EnterpriseRepairTicketHistoryEntry,
  EnterpriseUnreadMessageNotification,
} from '../../preload/index.js';
import { isAuthenticatedEnterpriseAccount } from '../internal-test-access.js';
import { createQrMatrix } from '../lib/qrMatrix.js';
import { startNonOverlappingPoll } from '../lib/nonOverlappingPoll.js';
import {
  buildAtoaRequest,
  displayDirectMessageContent,
} from '../atoaProtocol.js';
import {
  IconCheckCheck,
  IconClose,
  IconCopy,
  IconPlus,
  IconWarning,
} from './icons.js';

const INBOX_REFRESH_MS = 8_000;

const PARK_REQUEST_SERVICE_NAMES = new Map<string, string>([
  ['renovation', '装修管理'],
  ['parking', '停车办理'],
  ['network-phone', '网络与固话'],
  ['meeting-room', '会议室预约'],
  ['electric-card', '电卡服务'],
  ['repair', '物业报修'],
  ['vehicle-visit', '车辆与访客'],
]);

const PARK_HISTORY_ACTION_LABELS: Record<
  EnterpriseRepairTicketHistoryEntry['action'],
  string
> = {
  created: '申请已提交',
  accept: '客服已受理',
  respond: '客服回复',
  transfer: '工单已转交',
  complete: '客服已办结',
  confirm: '你已确认验收',
};

function inboxTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const isoValue = value.replace(' ', 'T');
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/iu.test(isoValue)
    ? isoValue
    : `${isoValue}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatInboxTimestamp(value: string | null | undefined): string {
  const timestamp = inboxTimestamp(value);
  if (!timestamp) return value ?? '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp);
}

function ticketApplicationNumber(ticket: EnterpriseRepairTicket): string {
  return ticket.applicationNumber || ticket.id.slice(-8).toUpperCase();
}

function ticketLatestTimestamp(ticket: EnterpriseRepairTicket): number {
  return inboxTimestamp(ticketLatestAt(ticket));
}

function ticketLatestAt(ticket: EnterpriseRepairTicket): string {
  const history = ticket.history ?? [];
  return history[history.length - 1]?.createdAt
    || ticket.responseAt
    || ticket.updatedAt
    || ticket.createdAt;
}

function creatorUpdateTimestamp(ticket: EnterpriseRepairTicket): number {
  if (ticket.creatorUpdateAt) return inboxTimestamp(ticket.creatorUpdateAt);
  if (ticket.responseAt) return inboxTimestamp(ticket.responseAt);
  const staffHistory = (ticket.history ?? []).filter(
    (entry) => entry.action !== 'created' && entry.action !== 'confirm',
  );
  return inboxTimestamp(staffHistory[staffHistory.length - 1]?.createdAt);
}

function isCreatorUpdateUnread(ticket: EnterpriseRepairTicket): boolean {
  const updateTimestamp = creatorUpdateTimestamp(ticket);
  if (ticket.isCreator === false || !updateTimestamp) return false;
  if (!ticket.creatorUpdateReadAt) return true;
  return inboxTimestamp(ticket.creatorUpdateReadAt) < updateTimestamp;
}

function ticketHistoryText(
  entry: EnterpriseRepairTicketHistoryEntry,
  ticket: EnterpriseRepairTicket,
): string {
  if (entry.action === 'created') {
    return [ticket.title, ticket.description].filter(Boolean).join('\n');
  }
  if (entry.action === 'accept') {
    return entry.responseText || '园区客服已受理申请，正在安排办理。';
  }
  if (entry.action === 'transfer') {
    return entry.responseText || '申请已转交给更合适的园区工作人员。';
  }
  if (entry.action === 'complete') {
    return entry.responseText || '申请已办结，请核对办理结果。';
  }
  if (entry.action === 'confirm') {
    return entry.responseText || '已确认本次服务的办理结果。';
  }
  return entry.responseText || entry.responseType || '园区客服更新了办理进展。';
}

function ticketPreview(ticket: EnterpriseRepairTicket): string {
  const history = ticket.history ?? [];
  const last = history[history.length - 1];
  if (!last) return ticket.responseText || ticket.description || ticket.status;
  const text = ticketHistoryText(last, ticket).replace(/\s+/gu, ' ').trim();
  return `${PARK_HISTORY_ACTION_LABELS[last.action]}：${text}`;
}

type InboxFilter = 'all' | 'unread' | 'handled';

function FederationVerificationQr({ payload }: { payload: string }): React.JSX.Element | null {
  const matrix = createQrMatrix(payload);
  if (!matrix) return null;
  const path = matrix
    .flatMap((row, y) =>
      row.flatMap((filled, x) => (filled ? [`M${x} ${y}h1v1h-1z`] : [])),
    )
    .join('');
  const size = matrix.length;
  return (
    <svg
      className="otto-inbox-page__security-qr"
      role="img"
      aria-label="联邦联系人安全号码二维码"
      viewBox={`-3 -3 ${size + 6} ${size + 6}`}
      shapeRendering="crispEdges"
    >
      <rect x={-3} y={-3} width={size + 6} height={size + 6} fill="#fff" />
      <path d={path} fill="#111" />
    </svg>
  );
}

export interface InboxPageProps {
  enterpriseAccount?: EnterpriseAccount;
  /** Commercial Federation entitlement. Undefined is deliberately fail-closed. */
  effectiveDirectMessages?: boolean;
  /** Same-organization messaging baseline after authoritative feature-state loading. */
  baselineDirectMessagesAvailable?: boolean;
  /** Same-organization directory baseline after authoritative feature-state loading. */
  baselineEnterpriseTreeAvailable?: boolean;
  /** Server-computed effective capability. Undefined is deliberately fail-closed. */
  effectiveAtoa?: boolean;
  /** Server-computed effective park-service capability. Undefined is fail-closed. */
  effectiveParkService?: boolean;
  enterpriseUnreadCounts?: Record<string, number>;
  onOpenDirectChat?: (peerAccountId: string) => void;
  /** 打开某会话后将该 peer 标记为已读（联动导航未读角标）。 */
  onMessageRead?: (peerAccountId: string, messageIds?: readonly string[]) => void;
  federationContactOpenRequest?: { contactId: string; requestId: number };
  onFederationMessageRead?: (contactId: string) => void;
  /** 客服更新在服务端确认已读后，立即清理导航角标。 */
  onParkTicketRead?: (ticketId: string) => void;
  onBack: () => void;
}

export interface ConversationItem {
  peerAccountId: string;
  peerName: string;
  peerDepartment: string | null;
  peerPositionTitle: string | null;
  lastMessage: string;
  lastMessageAt: string;
  unreadCount: number;
  online: boolean;
}

type UnifiedInboxConversation =
  | {
      key: string;
      kind: 'direct';
      timestamp: number;
      unreadCount: number;
      conversation: ConversationItem;
    }
  | {
      key: string;
      kind: 'federation';
      timestamp: number;
      unreadCount: number;
      contact: EnterpriseFederationContact;
    }
  | {
      key: string;
      kind: 'park';
      timestamp: number;
      unreadCount: number;
      ticket: EnterpriseRepairTicket;
    };

export function InboxPage({
  enterpriseAccount,
  effectiveDirectMessages = false,
  baselineDirectMessagesAvailable,
  baselineEnterpriseTreeAvailable,
  effectiveAtoa = false,
  effectiveParkService = false,
  enterpriseUnreadCounts = {},
  onOpenDirectChat: _onOpenDirectChat,
  onMessageRead,
  federationContactOpenRequest,
  onFederationMessageRead,
  onParkTicketRead,
  onBack,
}: InboxPageProps): React.JSX.Element {
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [notifications, setNotifications] = useState<EnterpriseUnreadMessageNotification[]>([]);
  const [orgMembers, setOrgMembers] = useState<EnterpriseOrganizationView['members']>([]);
  const [loading, setLoading] = useState(false);
  const [selectedPeer, setSelectedPeer] = useState<string | null>(null);
  const [selectedFederationContactId, setSelectedFederationContactId] = useState<string | null>(null);
  const [selectedParkTicketId, setSelectedParkTicketId] = useState<string | null>(null);
  const [parkTickets, setParkTickets] = useState<EnterpriseRepairTicket[]>([]);
  const [parkError, setParkError] = useState('');
  const [parkActionPending, setParkActionPending] = useState(false);
  const [federationContacts, setFederationContacts] = useState<EnterpriseFederationContact[]>([]);
  const [federationSetupOpen, setFederationSetupOpen] = useState(false);
  const [federationContactCode, setFederationContactCode] = useState('');
  const [federationError, setFederationError] = useState('');
  const [federationVerification, setFederationVerification] = useState<{
    safetyNumber: string;
    qrPayload: string;
    verifiedAt: string | null;
  } | null>(null);
  const [messages, setMessages] = useState<EnterpriseDirectMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [replyInput, setReplyInput] = useState('');
  const [federationAttachments, setFederationAttachments] = useState<
    EnterpriseDirectMessageAttachmentUpload[]
  >([]);
  const [sending, setSending] = useState(false);
  // 已读会话也要留在列表里：记录拉取过消息的 peer 及其最后一条消息
  const [historyPeers, setHistoryPeers] = useState<Record<string, { lastMessage: string; lastMessageAt: string }>>({});
  const hasAuth = isAuthenticatedEnterpriseAccount(enterpriseAccount);
  const canUseBaselineMessages =
    baselineDirectMessagesAvailable ?? effectiveDirectMessages;
  const canUseFederationMessages = effectiveDirectMessages === true;
  const canUseOwnOrganizationDirectory =
    baselineEnterpriseTreeAvailable ?? canUseBaselineMessages;
  const canUseAtoa = effectiveAtoa === true;

  // —— 加载未读通知 ——
  const refreshNotifications = useCallback(async (): Promise<void> => {
    if (!hasAuth || !canUseBaselineMessages) return;
    try {
      const data = await window.otto.enterpriseMessagesUnread();
      setNotifications(Array.isArray(data) ? data : []);
    } catch { /* 网络错误不清空已有数据 */ }
  }, [canUseBaselineMessages, hasAuth]);

  const refreshFederationContacts = useCallback(async (): Promise<void> => {
    if (!hasAuth || !canUseFederationMessages) return;
    try {
      const contacts = await window.otto.enterpriseFederationContacts();
      setFederationContacts(Array.isArray(contacts) ? contacts : []);
    } catch {
      // Federation is optional. Keep the local inbox available when it is not licensed.
    }
  }, [canUseFederationMessages, hasAuth]);

  // 申请人视角必须读取持久化工单列表，而不是仅读一次性未读通知。
  const refreshParkTickets = useCallback(async (): Promise<void> => {
    if (!hasAuth || !effectiveParkService) return;
    try {
      const tickets = await window.otto.enterpriseTicketList();
      setParkTickets((Array.isArray(tickets) ? tickets : [])
        .filter((ticket) => ticket.isCreator === true || ticket.creator.id === enterpriseAccount?.id)
        .filter((ticket) => PARK_REQUEST_SERVICE_NAMES.has(ticket.serviceId))
        .sort((a, b) => ticketLatestTimestamp(b) - ticketLatestTimestamp(a)));
      setParkError('');
    } catch {
      // 旧服务器或未开通园区服务时不影响企业私聊。
    }
  }, [effectiveParkService, enterpriseAccount?.id, hasAuth]);

  // —— 加载组织成员 ——
  useEffect(() => {
    if (!hasAuth || !canUseBaselineMessages || !canUseOwnOrganizationDirectory) return;
    let cancelled = false;
    void window.otto.enterpriseOrganizationView().then((view) => {
      if (!cancelled && view?.members) setOrgMembers(view.members);
    }).catch(() => { /* 忽略 */ });
    return () => { cancelled = true; };
  }, [canUseBaselineMessages, canUseOwnOrganizationDirectory, hasAuth, enterpriseAccount?.organizationId]);

  // —— 定时刷新 ——
  useEffect(() => {
    if (!hasAuth) return;
    setLoading(true);
    void Promise.all([
      refreshNotifications(),
      refreshFederationContacts(),
      refreshParkTickets(),
    ]).finally(() => setLoading(false));
    return startNonOverlappingPoll(
      async () => {
        await Promise.all([
          refreshNotifications(),
          refreshFederationContacts(),
          refreshParkTickets(),
        ]);
      },
      INBOX_REFRESH_MS,
      { runImmediately: false },
    );
  }, [
    canUseBaselineMessages,
    canUseFederationMessages,
    hasAuth,
    refreshFederationContacts,
    refreshNotifications,
    refreshParkTickets,
  ]);

  useEffect(() => {
    if (canUseBaselineMessages || canUseFederationMessages) return;
    setNotifications([]);
    setOrgMembers([]);
    setFederationContacts([]);
    setSelectedPeer(null);
    setSelectedFederationContactId(null);
    setMessages([]);
    setFederationAttachments([]);
    setFederationVerification(null);
    setFederationSetupOpen(false);
    setFederationError('');
    setMessagesLoading(false);
  }, [canUseBaselineMessages, canUseFederationMessages]);

  useEffect(() => {
    if (canUseFederationMessages) return;
    setFederationContacts([]);
    setSelectedFederationContactId(null);
    setFederationAttachments([]);
    setFederationVerification(null);
    setFederationSetupOpen(false);
    setFederationError('');
  }, [canUseFederationMessages]);

  useEffect(() => {
    if (effectiveParkService) return;
    setParkTickets([]);
    setSelectedParkTicketId(null);
    setParkError('');
    setParkActionPending(false);
  }, [effectiveParkService]);

  // —— 构建会话列表 ——
  const conversations = useMemo<ConversationItem[]>(() => {
    const memberMap = new Map(orgMembers.map((m) => [m.id, m]));
    const convMap = new Map<string, ConversationItem>();

    // 从未读通知构建
    for (const notif of notifications) {
      const member = memberMap.get(notif.senderAccountId);
      const unreadKey = `enterprise:message:${notif.senderAccountId}`;
      const unread = enterpriseUnreadCounts[unreadKey] ?? 0;
      convMap.set(notif.senderAccountId, {
        peerAccountId: notif.senderAccountId,
        peerName: notif.senderName || member?.name || notif.senderAccountId,
        peerDepartment: member?.department ?? null,
        peerPositionTitle: member?.positionTitle ?? null,
        lastMessage: notif.preview,
        lastMessageAt: notif.createdAt,
        unreadCount: unread,
        online: member?.ottoOnline ?? false,
      });
    }

    // 补充有未读计数但不在通知里的
    for (const [key, count] of Object.entries(enterpriseUnreadCounts)) {
      if (!key.startsWith('enterprise:message:') || count <= 0) continue;
      const peerId = key.slice('enterprise:message:'.length);
      if (convMap.has(peerId)) continue;
      const member = memberMap.get(peerId);
      if (!member) continue;
      convMap.set(peerId, {
        peerAccountId: peerId,
        peerName: member.name,
        peerDepartment: member.department,
        peerPositionTitle: member.positionTitle ?? null,
        lastMessage: '',
        lastMessageAt: '',
        unreadCount: count,
        online: member.ottoOnline ?? false,
      });
    }

    // 补充已读过消息的会话（未读为 0 也要留在列表，否则发完回复会话会消失）
    for (const [peerId, history] of Object.entries(historyPeers)) {
      if (convMap.has(peerId)) continue;
      const member = memberMap.get(peerId);
      if (!member) continue;
      convMap.set(peerId, {
        peerAccountId: peerId,
        peerName: member.name,
        peerDepartment: member.department,
        peerPositionTitle: member.positionTitle ?? null,
        lastMessage: history.lastMessage,
        lastMessageAt: history.lastMessageAt,
        unreadCount: 0,
        online: member.ottoOnline ?? false,
      });
    }

    return [...convMap.values()].sort((a, b) => {
      if (a.unreadCount !== b.unreadCount) return b.unreadCount - a.unreadCount;
      return b.lastMessageAt.localeCompare(a.lastMessageAt);
    });
  }, [notifications, orgMembers, enterpriseUnreadCounts, historyPeers]);

  // 企业私信、跨服务器联系人和园区工单共用一份会话目录，严格按最后动态时间混排。
  const unifiedConversations = useMemo<UnifiedInboxConversation[]>(() => [
    ...conversations.map((conversation): UnifiedInboxConversation => ({
      key: `direct:${conversation.peerAccountId}`,
      kind: 'direct',
      timestamp: inboxTimestamp(conversation.lastMessageAt),
      unreadCount: conversation.unreadCount,
      conversation,
    })),
    ...federationContacts.map((contact): UnifiedInboxConversation => ({
      key: `federation:${contact.id}`,
      kind: 'federation',
      timestamp: inboxTimestamp(contact.lastMessageAt || contact.updatedAt || contact.createdAt),
      unreadCount: contact.unreadCount,
      contact,
    })),
    ...parkTickets.map((ticket): UnifiedInboxConversation => ({
      key: `park:${ticket.id}`,
      kind: 'park',
      timestamp: ticketLatestTimestamp(ticket),
      unreadCount: isCreatorUpdateUnread(ticket) ? 1 : 0,
      ticket,
    })),
  ].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
    if (a.unreadCount !== b.unreadCount) return b.unreadCount - a.unreadCount;
    return a.key.localeCompare(b.key);
  }), [conversations, federationContacts, parkTickets]);

  const filteredConversations = useMemo(() => {
    if (filter === 'unread') {
      return unifiedConversations.filter((item) => item.unreadCount > 0);
    }
    if (filter === 'handled') {
      return unifiedConversations.filter((item) => item.unreadCount === 0);
    }
    return unifiedConversations;
  }, [filter, unifiedConversations]);

  const totalUnread = useMemo(
    () => unifiedConversations.reduce((sum, item) => sum + item.unreadCount, 0),
    [unifiedConversations],
  );
  const totalConversationCount = unifiedConversations.length;
  const unreadConversationCount = unifiedConversations.filter((item) => item.unreadCount > 0).length;
  const readConversationCount = totalConversationCount - unreadConversationCount;

  // —— 加载选中会话的消息，并标记该 peer 已读 ——
  useEffect(() => {
    if (!canUseBaselineMessages || !selectedPeer || selectedFederationContactId) return;
    let cancelled = false;
    setMessagesLoading(true);
    void window.otto.enterpriseMessagesList(selectedPeer).then((msgs) => {
      if (cancelled) return;
      const safeMessages = Array.isArray(msgs) ? msgs : [];
      setMessages(safeMessages);
      const last = safeMessages[safeMessages.length - 1];
      if (last) {
        setHistoryPeers((cur) => ({
          ...cur,
          [selectedPeer]: { lastMessage: last.content, lastMessageAt: last.createdAt },
        }));
      }
      const inboundMessageIds = safeMessages
        .filter((message) => message.senderAccountId === selectedPeer)
        .map((message) => message.id);
      if (inboundMessageIds.length > 0) {
        onMessageRead?.(selectedPeer, inboundMessageIds);
      } else {
        onMessageRead?.(selectedPeer);
      }
    }).catch(() => { /* 忽略 */ }).finally(() => {
      if (!cancelled) setMessagesLoading(false);
    });
    return () => { cancelled = true; };
  }, [canUseBaselineMessages, selectedFederationContactId, selectedPeer, onMessageRead]);

  useEffect(() => {
    if (!canUseFederationMessages || !selectedFederationContactId) return;
    let cancelled = false;
    setMessagesLoading(true);
    setFederationError('');
    void window.otto.enterpriseFederationMessagesList(selectedFederationContactId)
      .then((items) => {
        if (!cancelled) {
          setMessages(Array.isArray(items) ? items : []);
          onFederationMessageRead?.(selectedFederationContactId);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMessages([]);
          setFederationError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setMessagesLoading(false);
      });
    void window.otto.enterpriseFederationContactVerification(
      selectedFederationContactId,
    ).then((verification) => {
      if (!cancelled) setFederationVerification(verification);
    }).catch(() => {
      if (!cancelled) setFederationVerification(null);
    });
    return () => { cancelled = true; };
  }, [canUseFederationMessages, onFederationMessageRead, selectedFederationContactId]);

  const selectedMember = useMemo(
    () => orgMembers.find((m) => m.id === selectedPeer) ?? null,
    [orgMembers, selectedPeer],
  );

  const selectedFederationContact = useMemo(
    () => federationContacts.find(
      (contact) => contact.id === selectedFederationContactId,
    ) ?? null,
    [federationContacts, selectedFederationContactId],
  );

  const selectedParkTicket = useMemo(
    () => parkTickets.find((ticket) => ticket.id === selectedParkTicketId) ?? null,
    [parkTickets, selectedParkTicketId],
  );

  // 打开客服会话才回执已读；已读后工单仍保留在持久化会话列表。
  useEffect(() => {
    if (!selectedParkTicket || !isCreatorUpdateUnread(selectedParkTicket)) return;
    let cancelled = false;
    void window.otto.enterpriseTicketRead(selectedParkTicket.id)
      .then((updated) => {
        if (cancelled) return;
        setParkTickets((tickets) => tickets.map(
          (ticket) => ticket.id === updated.id ? updated : ticket,
        ));
        onParkTicketRead?.(updated.id);
        setParkError('');
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setParkError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => { cancelled = true; };
  }, [onParkTicketRead, selectedParkTicket]);

  useEffect(() => {
    setFederationAttachments([]);
  }, [selectedFederationContactId, selectedParkTicketId, selectedPeer]);

  useEffect(() => {
    const contactId = federationContactOpenRequest?.contactId;
    if (
      !canUseFederationMessages ||
      !contactId ||
      !federationContacts.some((contact) => contact.id === contactId)
    ) {
      return;
    }
    setSelectedPeer(null);
    setSelectedParkTicketId(null);
    setSelectedFederationContactId(contactId);
    setReplyInput('');
  }, [canUseFederationMessages, federationContactOpenRequest, federationContacts]);

  const handleSendReply = async (): Promise<void> => {
    const text = replyInput.trim();
    if (
      (!text && federationAttachments.length === 0) ||
      (!selectedPeer && !selectedFederationContactId) || sending
    ) return;
    if (selectedFederationContactId ? !canUseFederationMessages : !canUseBaselineMessages) {
      return;
    }
    setSending(true);
    try {
      const msg = selectedFederationContactId
        ? await window.otto.enterpriseFederationMessageSend(
            selectedFederationContactId,
            text,
            federationAttachments,
          )
        : await window.otto.enterpriseMessageSend(selectedPeer!, text);
      setMessages((cur) => [...cur, msg]);
      if (selectedPeer) {
        setHistoryPeers((cur) => ({
          ...cur,
          [selectedPeer]: { lastMessage: msg.content, lastMessageAt: msg.createdAt },
        }));
      }
      setReplyInput('');
      setFederationAttachments([]);
      setFederationError('');
      if (selectedFederationContactId) void refreshFederationContacts();
    } catch (error) {
      if (selectedFederationContactId) {
        setFederationError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setSending(false);
    }
  };

  const askFederationPeerOtto = async (): Promise<void> => {
    const question = replyInput.trim();
    if (
      !canUseFederationMessages ||
      !canUseAtoa ||
      !selectedFederationContactId || !selectedFederationContact ||
      !question || sending || federationAttachments.length > 0
    ) return;
    if (selectedFederationContact.trustState !== 'verified') {
      setFederationError('请先核验联系人安全号码，再向对方 Otto 提问。');
      return;
    }
    setSending(true);
    try {
      const message = await window.otto.enterpriseFederationMessageSend(
        selectedFederationContactId,
        buildAtoaRequest(question, { mode: 'answer' }),
      );
      setMessages((current) => [...current, message]);
      setReplyInput('');
      setFederationError('');
      void refreshFederationContacts();
    } catch (error) {
      setFederationError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  const addFederationFiles = async (files: FileList | File[]): Promise<void> => {
    if (!canUseFederationMessages) return;
    try {
      const next = [...federationAttachments];
      for (const file of Array.from(files)) {
        if (next.length >= 6) throw new Error('每条消息最多发送 6 个附件');
        if (file.size < 1 || file.size > 1024 * 1024 * 1024) {
          throw new Error(`${file.name} 超过 1 GB 或内容为空`);
        }
        const sourcePath = await window.otto.authorizeFileForAttachment(file);
        next.push({
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          sourcePath,
        });
      }
      if (next.reduce((sum, item) => sum + item.size, 0) > 1024 * 1024 * 1024) {
        throw new Error('每条消息的附件总大小不能超过 1 GB');
      }
      setFederationAttachments(next);
      setFederationError('');
    } catch (error) {
      setFederationError(error instanceof Error ? error.message : String(error));
    }
  };

  const saveFederationAttachment = async (
    messageId: string,
    attachment: NonNullable<EnterpriseDirectMessage['attachments']>[number],
  ): Promise<void> => {
    if (!canUseFederationMessages || !selectedFederationContactId) return;
    try {
      await window.otto.enterpriseFederationAttachmentSave(
        selectedFederationContactId,
        messageId,
        attachment.id,
        attachment.fileName,
      );
      setFederationError('');
    } catch (error) {
      setFederationError(error instanceof Error ? error.message : String(error));
    }
  };

  const copyFederationContactCode = async (): Promise<void> => {
    if (!canUseFederationMessages) return;
    try {
      const code = await window.otto.enterpriseFederationContactCode();
      await navigator.clipboard.writeText(code);
      setFederationError('');
    } catch (error) {
      setFederationError(error instanceof Error ? error.message : String(error));
    }
  };

  const importFederationContact = async (): Promise<void> => {
    if (!canUseFederationMessages || !federationContactCode.trim()) return;
    try {
      const contact = await window.otto.enterpriseFederationContactImport(
        federationContactCode,
      );
      setFederationContactCode('');
      setFederationSetupOpen(false);
      setSelectedPeer(null);
      setSelectedParkTicketId(null);
      setSelectedFederationContactId(contact.id);
      await refreshFederationContacts();
      setFederationError('');
    } catch (error) {
      setFederationError(error instanceof Error ? error.message : String(error));
    }
  };

  const confirmFederationVerification = async (): Promise<void> => {
    if (!canUseFederationMessages || !selectedFederationContactId) return;
    try {
      const verification = await window.otto.enterpriseFederationContactVerify(
        selectedFederationContactId,
      );
      setFederationVerification(verification);
      await refreshFederationContacts();
      setFederationError('');
    } catch (error) {
      setFederationError(error instanceof Error ? error.message : String(error));
    }
  };

  const removeFederationContact = async (): Promise<void> => {
    if (
      !canUseFederationMessages ||
      !selectedFederationContactId ||
      !selectedFederationContact
    ) return;
    if (!window.confirm(`移除跨服务器联系人“${selectedFederationContact.displayName}”？`)) {
      return;
    }
    try {
      await window.otto.enterpriseFederationContactRemove(selectedFederationContactId);
      setSelectedFederationContactId(null);
      setFederationVerification(null);
      setMessages([]);
      await refreshFederationContacts();
      setFederationError('');
    } catch (error) {
      setFederationError(error instanceof Error ? error.message : String(error));
    }
  };

  const confirmParkTicket = async (): Promise<void> => {
    if (!selectedParkTicket || selectedParkTicket.status !== '待验收' || parkActionPending) {
      return;
    }
    setParkActionPending(true);
    try {
      const updated = await window.otto.enterpriseTicketAction(
        selectedParkTicket.id,
        { action: 'confirm' },
      );
      setParkTickets((tickets) => tickets.map(
        (ticket) => ticket.id === updated.id ? updated : ticket,
      ));
      setParkError('');
    } catch (error) {
      setParkError(error instanceof Error ? error.message : String(error));
    } finally {
      setParkActionPending(false);
    }
  };

  const renderParkTimeline = (ticket: EnterpriseRepairTicket): React.JSX.Element => {
    const fallbackHistory: EnterpriseRepairTicketHistoryEntry[] = [{
      id: `created:${ticket.id}`,
      action: 'created' as const,
      statusBefore: null,
      statusAfter: ticket.status,
      responseType: null,
      responseText: null,
      createdAt: ticket.createdAt,
      actor: ticket.creator,
    }];
    if (ticket.responseAt || ticket.responseText) {
      fallbackHistory.push({
        id: `response:${ticket.id}`,
        action: ticket.status === '待验收' || ticket.status === '已完成'
          ? 'complete'
          : 'respond',
        statusBefore: null,
        statusAfter: ticket.status,
        responseType: ticket.responseType,
        responseText: ticket.responseText,
        createdAt: ticket.responseAt || ticket.updatedAt,
        actor: null,
      });
    }
    const history = ticket.history?.length ? ticket.history : fallbackHistory;
    return (
      <>
        <div className="otto-inbox-page__messages otto-inbox-page__ticket-timeline">
          {history.map((entry) => {
            const mine = entry.action === 'created' || entry.action === 'confirm';
            return (
              <div
                key={entry.id}
                className={`otto-inbox-page__msg${mine ? ' is-mine' : ''}`}
              >
                <span className="otto-inbox-page__ticket-event-label">
                  {PARK_HISTORY_ACTION_LABELS[entry.action]}
                  {!mine && entry.actor?.name ? ` · ${entry.actor.name}` : ''}
                </span>
                <span className="otto-inbox-page__msg-bubble">
                  {entry.responseType ? (
                    <strong className="otto-inbox-page__ticket-response-type">
                      {entry.responseType}
                    </strong>
                  ) : null}
                  <span>{ticketHistoryText(entry, ticket)}</span>
                  {entry.statusBefore && entry.statusBefore !== entry.statusAfter ? (
                    <small className="otto-inbox-page__ticket-status-change">
                      {entry.statusBefore} → {entry.statusAfter}
                    </small>
                  ) : null}
                </span>
                <span className="otto-inbox-page__msg-meta">
                  <time>{formatInboxTimestamp(entry.createdAt)}</time>
                </span>
              </div>
            );
          })}
        </div>
        <footer className="otto-inbox-page__ticket-footer">
          <span>客服的办理回复会自动同步到这里，会话在读取后仍会保留。</span>
          {ticket.status === '待验收' ? (
            <button
              type="button"
              disabled={parkActionPending}
              onClick={() => { void confirmParkTicket(); }}
            >
              {parkActionPending ? '确认中…' : '确认办理完成'}
            </button>
          ) : null}
        </footer>
      </>
    );
  };

  const renderMessages = (emptyLabel: string): React.JSX.Element => (
    <div className="otto-inbox-page__messages">
      {messagesLoading ? (
        <div className="otto-inbox-page__empty">加载消息中…</div>
      ) : messages.length === 0 ? (
        <div className="otto-inbox-page__empty">{emptyLabel}</div>
      ) : messages.map((msg) => {
        const mine = msg.senderAccountId === enterpriseAccount?.id;
        const deliveryStatus = 'deliveryStatus' in msg &&
          typeof msg.deliveryStatus === 'string'
          ? msg.deliveryStatus
          : null;
        return (
          <div key={msg.id} className={`otto-inbox-page__msg${mine ? ' is-mine' : ''}`}>
            <span className="otto-inbox-page__msg-bubble">
              {msg.content ? (
                <span>{displayDirectMessageContent(msg.content)}</span>
              ) : null}
              {(msg.attachments ?? []).map((attachment) => (
                <span key={attachment.id} className="otto-inbox-page__attachment">
                  <span>
                    <strong>{attachment.fileName}</strong>
                    <small>{(attachment.size / 1024 / 1024).toFixed(1)} MB</small>
                  </span>
                  {selectedFederationContactId && !mine ? (
                    <button
                      type="button"
                      onClick={() => { void saveFederationAttachment(msg.id, attachment); }}
                    >
                      保存
                    </button>
                  ) : null}
                </span>
              ))}
            </span>
            <span className="otto-inbox-page__msg-meta">
              <time>{new Date(msg.createdAt).toLocaleString('zh-CN', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
              })}</time>
              {deliveryStatus ? (
                <span>{deliveryStatus === 'received' ? '已接收' : deliveryStatus === 'sent' ? '已送达' : deliveryStatus === 'queued' ? '待投递' : deliveryStatus === 'failed' ? '投递失败' : '已过期'}</span>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );

  const renderReply = (placeholder: string): React.JSX.Element => (
    <form
      className="otto-inbox-page__reply"
      onSubmit={(event) => { event.preventDefault(); void handleSendReply(); }}
    >
      <textarea
        value={replyInput}
        onChange={(event) => setReplyInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void handleSendReply();
          }
        }}
        placeholder={placeholder}
        rows={2}
        maxLength={4000}
        aria-label="回复消息"
      />
      {selectedFederationContactId ? (
        <div className="otto-inbox-page__reply-actions">
          <label className="otto-inbox-page__attach-button">
            <input
              type="file"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files) void addFederationFiles(event.target.files);
                event.target.value = '';
              }}
            />
            添加文件
          </label>
          {canUseAtoa ? (
            <button
              type="button"
              className="otto-inbox-page__a2a-button"
              disabled={
                !replyInput.trim() || sending || federationAttachments.length > 0 ||
                selectedFederationContact?.trustState !== 'verified'
              }
              title={selectedFederationContact?.trustState === 'verified'
                ? '对方必须明确批准资料范围，授权仅使用一次'
                : '请先核验联系人身份'}
              onClick={() => { void askFederationPeerOtto(); }}
            >
              询问对方 Otto
            </button>
          ) : null}
        </div>
      ) : null}
      {selectedFederationContactId && federationAttachments.length > 0 ? (
        <div className="otto-inbox-page__pending-attachments">
          {federationAttachments.map((attachment, index) => (
            <span key={`${attachment.fileName}:${index}`}>
              {attachment.fileName}
              <button
                type="button"
                aria-label={`移除 ${attachment.fileName}`}
                onClick={() => setFederationAttachments((items) =>
                  items.filter((_, itemIndex) => itemIndex !== index))}
              >
                <IconClose size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <button
        type="submit"
        disabled={(!replyInput.trim() && federationAttachments.length === 0) || sending}
      >
        {sending ? '发送中' : '发送'}
      </button>
    </form>
  );

  if (!hasAuth) {
    return (
      <div className="otto-inbox-page" role="region" aria-label="我的消息">
        <header className="otto-inbox-page__header">
          <h1>我的消息</h1>
          <button type="button" onClick={onBack}>返回</button>
        </header>
        <div className="otto-inbox-page__empty">需要企业账号登录后查看消息。</div>
      </div>
    );
  }

  return (
    <div className="otto-inbox-page" role="region" aria-label="我的消息">
      <header className="otto-inbox-page__header">
        <div>
          <h1>我的消息</h1>
          <p>{totalConversationCount} 个会话{totalUnread > 0 ? ` · ${totalUnread} 条未读` : ''}</p>
        </div>
        <button type="button" onClick={onBack}>返回对话</button>
      </header>

      <div className="otto-inbox-page__filters" role="tablist" aria-label="消息过滤">
        {([
          ['all', `全部 ${totalConversationCount}`],
          ['unread', `未读 ${unreadConversationCount}`],
          ['handled', `已读 ${readConversationCount}`],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={filter === key}
            className={filter === key ? 'is-active' : ''}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="otto-inbox-page__layout">
        {/* 左：会话列表 */}
        <div className="otto-inbox-page__list" role="list" aria-label="会话列表">
          {!canUseBaselineMessages && !canUseFederationMessages ? (
            <div className="otto-inbox-page__capability-note" role="status">
              <span>企业私聊未启用或当前服务器未授权，不会请求企业消息数据。</span>
              {effectiveParkService ? <span>园区服务会话仍会正常加载。</span> : null}
            </div>
          ) : null}
          {canUseFederationMessages ? <div className="otto-inbox-page__federation-actions">
            <button
              type="button"
              title="复制我的跨服务器联系码"
              onClick={() => { void copyFederationContactCode(); }}
            >
              <IconCopy size={14} />
              复制我的联系码
            </button>
            <button
              type="button"
              title="添加跨服务器联系人"
              aria-expanded={federationSetupOpen}
              onClick={() => setFederationSetupOpen((open) => !open)}
            >
              <IconPlus size={14} />
              添加联系人
            </button>
          </div> : null}
          {canUseFederationMessages && federationSetupOpen ? (
            <div className="otto-inbox-page__federation-setup">
              <label htmlFor="otto-federation-contact-code">粘贴对方的联系码</label>
              <textarea
                id="otto-federation-contact-code"
                value={federationContactCode}
                onChange={(event) => setFederationContactCode(event.target.value)}
                rows={3}
                spellCheck={false}
                placeholder="OTTO_FEDERATION_CONTACT_V1:…"
              />
              <button
                type="button"
                disabled={!federationContactCode.trim()}
                onClick={() => { void importFederationContact(); }}
              >
                导入联系人
              </button>
            </div>
          ) : null}
          {canUseFederationMessages && federationError && !selectedFederationContactId ? (
            <div className="otto-inbox-page__error" role="alert">{federationError}</div>
          ) : null}
          {loading && totalConversationCount === 0 ? (
            <div className="otto-inbox-page__empty">正在加载消息…</div>
          ) : filteredConversations.length === 0 ? (
            <div className="otto-inbox-page__empty">
              {filter === 'unread' ? '没有未读消息' : filter === 'handled' ? '没有已读消息' : '暂无消息'}
            </div>
          ) : filteredConversations.map((item) => {
            if (item.kind === 'park') {
              const { ticket } = item;
              const serviceName = PARK_REQUEST_SERVICE_NAMES.get(ticket.serviceId)
                || ticket.serviceId;
              return (
                <button
                  key={item.key}
                  type="button"
                  role="listitem"
                  aria-label={`${serviceName}客服，申请编号 ${ticketApplicationNumber(ticket)}，${item.unreadCount} 条未读`}
                  className={`otto-inbox-page__conv${selectedParkTicketId === ticket.id ? ' is-selected' : ''}`}
                  onClick={() => {
                    setSelectedPeer(null);
                    setSelectedFederationContactId(null);
                    setSelectedParkTicketId(ticket.id);
                    setReplyInput('');
                  }}
                >
                  <span className="otto-inbox-page__conv-avatar otto-inbox-page__conv-avatar--park" aria-hidden>
                    园
                  </span>
                  <span className="otto-inbox-page__conv-body">
                    <strong>{serviceName}客服</strong>
                    <span className="otto-inbox-page__conv-meta">
                      园区服务 · {ticketApplicationNumber(ticket)} · {ticket.status}
                    </span>
                    <span className="otto-inbox-page__conv-preview">{ticketPreview(ticket)}</span>
                  </span>
                  <span className="otto-inbox-page__conv-side">
                    <time className="otto-inbox-page__conv-time">
                      {formatInboxTimestamp(ticketLatestAt(ticket))}
                    </time>
                    {item.unreadCount > 0 ? (
                      <span className="otto-inbox-page__unread" role="status">{item.unreadCount}</span>
                    ) : null}
                  </span>
                </button>
              );
            }

            if (item.kind === 'federation') {
              const { contact } = item;
              return (
                <button
                  key={item.key}
                  type="button"
                  role="listitem"
                  aria-label={`${contact.displayName}，跨服务器联系人，${item.unreadCount} 条未读`}
                  className={`otto-inbox-page__conv${selectedFederationContactId === contact.id ? ' is-selected' : ''}`}
                  onClick={() => {
                    setSelectedPeer(null);
                    setSelectedParkTicketId(null);
                    setSelectedFederationContactId(contact.id);
                    setReplyInput('');
                  }}
                >
                  <span className="otto-inbox-page__conv-avatar otto-inbox-page__conv-avatar--federated" aria-hidden>
                    {contact.displayName.slice(0, 1)}
                  </span>
                  <span className="otto-inbox-page__conv-body">
                    <strong>{contact.displayName}</strong>
                    <span className="otto-inbox-page__conv-meta">{contact.deploymentDisplayName}</span>
                    <span className={`otto-inbox-page__trust${contact.trustState === 'verified' ? ' is-verified' : ''}`}>
                      {contact.trustState === 'verified' ? '已核验身份' : '身份待核验'}
                    </span>
                  </span>
                  <span className="otto-inbox-page__conv-side">
                    {contact.lastMessageAt ? (
                      <time className="otto-inbox-page__conv-time">
                        {formatInboxTimestamp(contact.lastMessageAt)}
                      </time>
                    ) : null}
                    {item.unreadCount > 0 ? (
                      <span className="otto-inbox-page__unread" role="status">{item.unreadCount}</span>
                    ) : null}
                  </span>
                </button>
              );
            }

            const { conversation: conv } = item;
            return (
              <button
                key={item.key}
                type="button"
                role="listitem"
                aria-label={`${conv.peerName}，本企业联系人，${item.unreadCount} 条未读`}
                className={`otto-inbox-page__conv${selectedPeer === conv.peerAccountId ? ' is-selected' : ''}`}
                onClick={() => {
                  setSelectedFederationContactId(null);
                  setSelectedParkTicketId(null);
                  setSelectedPeer(conv.peerAccountId);
                  setReplyInput('');
                }}
              >
                <span className="otto-inbox-page__conv-avatar" aria-hidden>
                  {conv.peerName.slice(0, 1)}
                </span>
                <span className="otto-inbox-page__conv-body">
                  <strong>{conv.peerName}</strong>
                  <span className="otto-inbox-page__conv-meta">
                    {conv.peerDepartment || ''}{conv.peerPositionTitle ? ` · ${conv.peerPositionTitle}` : ''}
                  </span>
                  {conv.lastMessage ? (
                    <span className="otto-inbox-page__conv-preview">{conv.lastMessage}</span>
                  ) : null}
                </span>
                <span className="otto-inbox-page__conv-side">
                  {conv.lastMessageAt ? (
                    <time className="otto-inbox-page__conv-time">
                      {formatInboxTimestamp(conv.lastMessageAt)}
                    </time>
                  ) : null}
                  {conv.online ? <span className="otto-inbox-page__online" aria-label="在线" /> : null}
                  {item.unreadCount > 0 ? (
                    <span className="otto-inbox-page__unread" role="status">{item.unreadCount}</span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>

        {/* 右：消息详情 */}
        <div className="otto-inbox-page__detail" aria-label="消息详情">
          {selectedParkTicketId && selectedParkTicket ? (
            <>
              <header className="otto-inbox-page__detail-header">
                <strong>
                  {PARK_REQUEST_SERVICE_NAMES.get(selectedParkTicket.serviceId)
                    || selectedParkTicket.serviceId}客服
                </strong>
                <span>申请编号 {ticketApplicationNumber(selectedParkTicket)}</span>
                <span className="otto-inbox-page__ticket-current-status">
                  {selectedParkTicket.status}
                </span>
              </header>
              {parkError ? (
                <div className="otto-inbox-page__error" role="alert">{parkError}</div>
              ) : null}
              {renderParkTimeline(selectedParkTicket)}
            </>
          ) : selectedFederationContactId && selectedFederationContact ? (
            <>
              <header className="otto-inbox-page__detail-header">
                <strong>{selectedFederationContact.displayName}</strong>
                <span>{selectedFederationContact.deploymentDisplayName}</span>
                <span className={`otto-inbox-page__security-state${selectedFederationContact.trustState === 'verified' ? ' is-verified' : ''}`}>
                  {selectedFederationContact.trustState === 'verified' ? <IconCheckCheck size={13} /> : <IconWarning size={13} />}
                  {selectedFederationContact.trustState === 'verified' ? '已核验' : '未核验'}
                </span>
                <button
                  type="button"
                  className="otto-inbox-page__remove-contact"
                  title="移除联系人"
                  aria-label="移除联系人"
                  onClick={() => { void removeFederationContact(); }}
                >
                  <IconClose size={14} />
                </button>
              </header>
              {federationVerification ? (
                <section className="otto-inbox-page__security" aria-label="端到端加密身份核验">
                  <FederationVerificationQr payload={federationVerification.qrPayload} />
                  <div>
                    <strong>端到端加密安全号码</strong>
                    <p>请通过电话或当面与对方核对。号码一致后再确认身份。</p>
                    <code>{federationVerification.safetyNumber.match(/.{1,4}/g)?.join(' ') ?? federationVerification.safetyNumber}</code>
                    {federationVerification.verifiedAt ? (
                      <span className="otto-inbox-page__verified-note"><IconCheckCheck size={14} /> 已于本设备核验</span>
                    ) : (
                      <button type="button" onClick={() => { void confirmFederationVerification(); }}>
                        我已核对，确认身份
                      </button>
                    )}
                  </div>
                </section>
              ) : null}
              {federationError ? (
                <div className="otto-inbox-page__error" role="alert">{federationError}</div>
              ) : null}
              {renderMessages(`开始与 ${selectedFederationContact.displayName} 进行加密对话`)}
              {renderReply(`加密回复 ${selectedFederationContact.displayName}…`)}
            </>
          ) : selectedPeer && selectedMember ? (
            <>
              <header className="otto-inbox-page__detail-header">
                <strong>{selectedMember.name}</strong>
                <span>{selectedMember.department || ''} · {selectedMember.positionTitle || selectedMember.role || ''}</span>
                {selectedMember.ottoOnline ? <span className="otto-inbox-page__presence">在线</span> : null}
              </header>
              {renderMessages(`开始与 ${selectedMember.name} 对话`)}
              {renderReply(`回复 ${selectedMember.name}…`)}
            </>
          ) : (
            <div className="otto-inbox-page__empty otto-inbox-page__empty--detail">
              选择左侧会话查看消息
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
