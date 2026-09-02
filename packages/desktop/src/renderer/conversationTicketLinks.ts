/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

const MAX_LINKS = 1_000;
const MAX_PENDING = 100;
const LINK_TTL_MS = 90 * 24 * 60 * 60 * 1_000;

export interface LinkedTicketSnapshot {
  id: string;
  applicationNumber?: string | null;
  title: string;
  status: string;
  responseType?: string | null;
  responseText?: string | null;
  creatorUpdateAt?: string | null;
  updatedAt: string;
}

interface TicketConversationLink {
  ticketId: string;
  sessionId: string;
  title: string;
  applicationNumber: string;
  fingerprint: string;
  revision: number;
  expiresAt: number;
  pendingMessage?: string;
  notificationSent?: boolean;
}

function clean(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function fingerprint(ticket: LinkedTicketSnapshot): string {
  return [
    clean(ticket.status, 100),
    clean(ticket.responseType, 100),
    clean(ticket.responseText, 1_000),
    clean(ticket.creatorUpdateAt, 100),
  ].join('\u0000');
}

function updateMessage(link: TicketConversationLink, ticket: LinkedTicketSnapshot): string {
  const response = clean(ticket.responseText, 800);
  return [
    `“${clean(ticket.title, 200) || link.title}”申请 **${clean(ticket.applicationNumber, 100) || link.applicationNumber}** 有新进展：`,
    `- 当前状态：${clean(ticket.status, 100) || '状态已更新'}`,
    ...(response ? [`- 工作人员回复：${response}`] : []),
    '',
    '右侧“我的申请”已同步更新。',
  ].join('\n');
}

export class ConversationTicketLinkRegistry {
  private readonly links = new Map<string, TicketConversationLink>();

  track(ticket: LinkedTicketSnapshot, sessionId: string, now: number = Date.now()): void {
    const ticketId = clean(ticket.id, 300);
    const safeSessionId = clean(sessionId, 500);
    if (!ticketId || !safeSessionId) return;
    this.links.delete(ticketId);
    this.links.set(ticketId, {
      ticketId,
      sessionId: safeSessionId,
      title: clean(ticket.title, 200) || '园区服务',
      applicationNumber: clean(ticket.applicationNumber, 100) || ticketId.slice(-8).toUpperCase(),
      fingerprint: fingerprint(ticket),
      revision: 0,
      expiresAt: now + LINK_TTL_MS,
    });
    this.enforceCapacity(now);
  }

  observe(tickets: readonly LinkedTicketSnapshot[], now: number = Date.now()): number {
    let changes = 0;
    for (const ticket of tickets) {
      const link = this.links.get(clean(ticket.id, 300));
      if (!link || link.expiresAt <= now) continue;
      const next = fingerprint(ticket);
      if (!next || next === link.fingerprint) continue;
      link.fingerprint = next;
      link.revision += 1;
      link.pendingMessage = updateMessage(link, ticket);
      link.notificationSent = false;
      changes += 1;
    }
    this.enforceCapacity(now);
    return changes;
  }

  pendingForSession(sessionId: string): Array<{ ticketId: string; message: string }> {
    return [...this.links.values()]
      .filter((link) => link.sessionId === sessionId && link.pendingMessage)
      .slice(0, MAX_PENDING)
      .map((link) => ({ ticketId: link.ticketId, message: link.pendingMessage! }));
  }

  pending(): Array<{
    ticketId: string;
    sessionId: string;
    message: string;
    notificationSent: boolean;
    revision: number;
  }> {
    return [...this.links.values()]
      .filter((link) => link.pendingMessage)
      .slice(0, MAX_PENDING)
      .map((link) => ({
        ticketId: link.ticketId,
        sessionId: link.sessionId,
        message: link.pendingMessage!,
        notificationSent: link.notificationSent === true,
        revision: link.revision,
      }));
  }

  markNotified(ticketId: string, sessionId: string): boolean {
    const link = this.links.get(ticketId);
    if (!link || link.sessionId !== sessionId || !link.pendingMessage) return false;
    link.notificationSent = true;
    return true;
  }

  markDelivered(ticketId: string, sessionId: string): boolean {
    const link = this.links.get(ticketId);
    if (!link || link.sessionId !== sessionId || !link.pendingMessage) return false;
    delete link.pendingMessage;
    delete link.notificationSent;
    return true;
  }

  snapshot(now: number = Date.now()): TicketConversationLink[] {
    this.enforceCapacity(now);
    return [...this.links.values()];
  }

  restore(payload: unknown, now: number = Date.now()): number {
    if (!Array.isArray(payload)) return 0;
    let restored = 0;
    for (const raw of payload.slice(0, MAX_LINKS)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const link = raw as Partial<TicketConversationLink>;
      if (
        typeof link.ticketId !== 'string'
        || !link.ticketId
        || typeof link.sessionId !== 'string'
        || !link.sessionId
        || typeof link.title !== 'string'
        || typeof link.applicationNumber !== 'string'
        || typeof link.fingerprint !== 'string'
        || typeof link.revision !== 'number'
        || !Number.isInteger(link.revision)
        || link.revision < 0
        || typeof link.expiresAt !== 'number'
        || link.expiresAt <= now
        || (link.pendingMessage !== undefined && typeof link.pendingMessage !== 'string')
        || (link.notificationSent !== undefined && typeof link.notificationSent !== 'boolean')
      ) continue;
      this.links.set(link.ticketId, link as TicketConversationLink);
      restored += 1;
    }
    this.enforceCapacity(now);
    return restored;
  }

  private enforceCapacity(now: number): void {
    for (const [id, link] of this.links) {
      if (link.expiresAt <= now) this.links.delete(id);
    }
    while (this.links.size > MAX_LINKS) {
      const oldest = this.links.keys().next().value as string | undefined;
      if (!oldest) break;
      this.links.delete(oldest);
    }
  }
}
