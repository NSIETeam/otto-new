/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

type ChatRole = 'user' | 'assistant';

interface ParkPublicationSummary {
  id: string;
  kind: 'announcement' | 'satisfaction';
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  submittedAt: string | null;
}

interface ParkStatisticsSummary {
  parkName: string;
  organizationCount: number;
  activeOrganizationCount: number;
  totalServiceUses: number;
  totalAmountCny: number;
  recurringMonthlyCny: number;
  vehicleVisits: number;
  meetingRoomBookings: number;
  services: Array<{ name: string; count: number; amountCny: number }>;
}

interface ParkStarMapSummary {
  parkName: string;
  currentOrganizationId: string;
  nodes: Array<{
    organizationId: string;
    organizationName: string;
    capabilities: string[];
    productsServices: string[];
    cooperationNeeds: string[];
    isPublic: boolean;
  }>;
  edges: Array<{
    sourceOrganizationId: string;
    targetOrganizationId: string;
    strength: string;
    evidence: string[];
    unverifiedQuestions: string[];
  }>;
}

interface ParkTicketSummary {
  id: string;
  applicationNumber?: string | null;
  serviceId: string;
  title: string;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  recipients: Array<{ id: string; name: string }>;
  recipientCount: number;
  isCreator?: boolean;
  isRecipient?: boolean;
}

export interface ParkQueryConversationInput {
  text: string;
  enabled: boolean;
  postMessage(role: ChatRole, text: string): void;
  listPublications(): Promise<ParkPublicationSummary[]>;
  loadStatistics(): Promise<ParkStatisticsSummary>;
  loadStarMap(): Promise<ParkStarMapSummary>;
  listMyApplications(): Promise<ParkTicketSummary[]>;
  listStaffTasks(): Promise<ParkTicketSummary[]>;
}

type ParkQueryKind = 'announcements' | 'statistics' | 'star-map' | 'my-applications' | 'staff-tasks';

const MAX_QUERY_ITEMS = 5;
const MAX_TEXT_LENGTH = 500;

function safeText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return Array.from(value.trim()).slice(0, MAX_TEXT_LENGTH).join('');
}

function rejectedQuery(text: string): boolean {
  return /(?:不想|不要|不用|无需|别).{0,8}(?:查|看|查询|打开|总结)/.test(text)
    || /(?:介绍|解释|是什么|怎么用|如何使用|功能)/.test(text);
}

export function detectParkQueryIntent(text: string): ParkQueryKind | null {
  const normalized = text.trim();
  if (!normalized || rejectedQuery(normalized)) return null;
  if (/(?:我的申请|申请进度|我提交的(?:申请|工单)|我的工单)/.test(normalized)) {
    return 'my-applications';
  }
  if (/(?:园区待办|分配给我的(?:任务|工单)|园区任务|待处理的园区|我的园区待办)/.test(normalized)) {
    return 'staff-tasks';
  }
  if (/(?:企业星链图|园区企业.{0,8}(?:合作|线索)|合作线索|园区内.{0,8}合作)/.test(normalized)) {
    return 'star-map';
  }
  if (/(?:园区服务统计|园区统计|园区服务数据|园区运营数据)/.test(normalized)) {
    return 'statistics';
  }
  if (/(?:园区公告|最新公告|未读公告)/.test(normalized)
    && /(?:查|看|有什么|哪些|最新|未读|总结|告诉|读一下|打开)/.test(normalized)) {
    return 'announcements';
  }
  return null;
}

function dateLabel(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(timestamp));
}

function money(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

function announcementMessage(items: ParkPublicationSummary[]): string {
  const announcements = items
    .filter((item) => item.kind === 'announcement')
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, MAX_QUERY_ITEMS);
  if (announcements.length === 0) return '当前没有可查看的园区公告。';
  const lines = announcements.map((item, index) => {
    const state = item.readAt ? '已读' : '未读';
    return `${index + 1}. **${safeText(item.title, '未命名公告')}**（${dateLabel(item.createdAt)}，${state}）\n   ${safeText(item.body, '无正文')}`;
  });
  return `最近的园区公告如下（本次对话查询不会自动标记已读）：\n\n${lines.join('\n\n')}`;
}

function statisticsMessage(value: ParkStatisticsSummary): string {
  const services = [...(value.services ?? [])]
    .sort((left, right) => right.count - left.count)
    .slice(0, 3)
    .map((service) => `${safeText(service.name, '未命名服务')} ${service.count} 次`)
    .join('、');
  return [
    `**${safeText(value.parkName, '当前园区')}服务统计**`,
    '',
    `- 企业总数：${value.organizationCount} 家企业，其中正常服务 ${value.activeOrganizationCount} 家`,
    `- 服务使用：${value.totalServiceUses} 次`,
    `- 累计金额：¥${money(value.totalAmountCny)}`,
    `- 每月持续费用：¥${money(value.recurringMonthlyCny)}`,
    `- 车辆来访：${value.vehicleVisits} 次；会议室预约：${value.meetingRoomBookings} 次`,
    ...(services ? [`- 使用最多：${services}`] : []),
  ].join('\n');
}

function starMapMessage(value: ParkStarMapSummary): string {
  const profiles = new Map(value.nodes.map((node) => [node.organizationId, node]));
  const lines = value.edges.slice(0, MAX_QUERY_ITEMS).flatMap((edge, index) => {
    const peerId = edge.sourceOrganizationId === value.currentOrganizationId
      ? edge.targetOrganizationId
      : edge.sourceOrganizationId;
    const peer = profiles.get(peerId);
    if (!peer?.isPublic) return [];
    const evidence = edge.evidence.map((item) => safeText(item)).filter(Boolean).join('；') || '暂未提供证据说明';
    const needs = peer.cooperationNeeds.map((item) => safeText(item)).filter(Boolean).join('、') || '未公开';
    return [`${index + 1}. **${safeText(peer.organizationName, '未命名企业')}**：${evidence}。合作需求：${needs}`];
  });
  if (lines.length === 0) return '企业星链图当前没有可展示的公开合作线索。';
  return `根据 **${safeText(value.parkName, '当前园区')}** 企业主动公开的信息，找到以下合作线索：\n\n${lines.join('\n\n')}\n\n这些是可解释线索，不代表对方已经确认合作。`;
}

function ticketMessage(items: ParkTicketSummary[], kind: 'mine' | 'staff'): string {
  const filtered = items
    .filter((ticket) => kind === 'mine' ? ticket.isCreator !== false : ticket.isRecipient !== false)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, MAX_QUERY_ITEMS);
  if (filtered.length === 0) {
    return kind === 'mine' ? '你目前没有园区服务申请。' : '目前没有分配给你的园区待办。';
  }
  const title = kind === 'mine' ? '最近的园区服务申请' : '当前园区待办';
  const lines = filtered.map((ticket, index) => {
    const number = safeText(ticket.applicationNumber) || safeText(ticket.id).slice(-8).toUpperCase();
    const recipient = ticket.recipients.map((item) => safeText(item.name)).filter(Boolean).join('、');
    return `${index + 1}. **${number} · ${safeText(ticket.title, ticket.serviceId)}**：${safeText(ticket.status, '状态未知')}${recipient ? `；当前处理人 ${recipient}` : ''}`;
  });
  return `${title}：\n\n${lines.join('\n\n')}`;
}

export async function handleParkQueryConversation(
  input: ParkQueryConversationInput,
): Promise<boolean> {
  if (!input.enabled) return false;
  const kind = detectParkQueryIntent(input.text);
  if (!kind) return false;
  input.postMessage('user', input.text.trim());
  try {
    if (kind === 'announcements') {
      input.postMessage('assistant', announcementMessage(await input.listPublications()));
    } else if (kind === 'statistics') {
      input.postMessage('assistant', statisticsMessage(await input.loadStatistics()));
    } else if (kind === 'star-map') {
      input.postMessage('assistant', starMapMessage(await input.loadStarMap()));
    } else if (kind === 'my-applications') {
      input.postMessage('assistant', ticketMessage(await input.listMyApplications(), 'mine'));
    } else {
      input.postMessage('assistant', ticketMessage(await input.listStaffTasks(), 'staff'));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    input.postMessage('assistant', `园区信息查询失败：${safeText(message, '未知错误')}。请稍后重试。`);
  }
  return true;
}
