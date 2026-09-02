/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ConversationActionDraftSummary } from './conversationActionDraft.js';

/**
 * Conversation-to-module bridge.
 *
 * The first production slice intentionally supports one action only: park
 * repair. The lifecycle and registry are generic so the other right-panel
 * modules can reuse the same prepare/update/confirm/submit boundary later.
 */

export const MODULE_ACTION_DRAFT_TTL_MS = 30 * 60 * 1_000;
export const MAX_MODULE_ACTION_DRAFTS = 10_000;

export const REPAIR_CATEGORIES = [
  '灯具维修',
  '配电维修',
  '暖通维修',
  '网络、电话故障维修',
  '园区车辆车牌变更',
] as const;

export const REPAIR_URGENCIES = ['普通', '紧急', '影响办公'] as const;

export interface RepairModuleDefaults {
  company: string;
  roomNumber: string;
  contact: string;
  phone: string;
}

export interface RepairModuleFields extends RepairModuleDefaults {
  category: string;
  issue: string;
  urgency: string;
}

export interface ModuleActionDraft {
  id: string;
  idempotencyKey: string;
  moduleId: 'park-repair';
  sessionId: string;
  accountId: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  phase: 'collecting' | 'awaiting_confirmation';
  autoSubmit: boolean;
  fields: RepairModuleFields;
}

export interface RepairTicketSubmitInput {
  idempotencyKey: string;
  serviceId: 'repair';
  title: string;
  description: string;
  formData: Record<string, string>;
  category: string;
  location: string;
  urgency: string;
  contact: string;
  contactPhone: string;
}

export interface RepairTicketSubmitResult {
  id: string;
  applicationNumber?: string | null;
  status: string;
  recipients: Array<{ id: string; name: string }>;
  recipientCount: number;
}

export interface ModuleActionTransition {
  assistantMessage: string;
  draft: ModuleActionDraft | null;
  shouldSubmit: boolean;
  cancelled?: boolean;
}

export interface PrepareModuleActionInput {
  text: string;
  sessionId: string;
  accountId: string;
  defaults: RepairModuleDefaults;
  now?: number;
}

export interface HandleModuleActionConversationInput {
  text: string;
  sessionId: string;
  accountId: string;
  enabled: boolean;
  registry: ModuleActionDraftRegistry;
  loadDefaults(): Promise<RepairModuleDefaults>;
  submit(input: RepairTicketSubmitInput): Promise<RepairTicketSubmitResult>;
  onSubmitted?(ticket: RepairTicketSubmitResult, draft: ModuleActionDraft): void;
  postMessage(role: 'user' | 'assistant', text: string): void;
  /** UI 草稿中心确认时必须绑定当前展示的草稿，拒绝串单或过期确认。 */
  expectedDraftId?: string;
  now?: () => number;
}

const REPAIR_FIELD_LABELS: Record<keyof RepairModuleFields, string> = {
  company: '公司名称',
  roomNumber: '房间号',
  contact: '联系人',
  phone: '联系电话',
  category: '报修类别',
  issue: '故障描述',
  urgency: '紧急程度',
};

const REPAIR_REQUIRED_FIELDS = Object.keys(REPAIR_FIELD_LABELS) as Array<keyof RepairModuleFields>;

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePhone(value: string): string {
  return value.replace(/^\+86/, '').replace(/[\s-]/g, '');
}

function repairIntent(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (/(?:不要|不用|无需|别|不想).{0,8}(?:帮我)?(?:物业)?报修/.test(normalized)) {
    return false;
  }
  if (
    /(?:解释|介绍|咨询|了解).{0,8}(?:物业)?报修/.test(normalized)
    || /(?:物业)?报修.{0,8}(?:流程|功能|是什么|怎么用|如何使用)/.test(normalized)
  ) {
    return false;
  }
  if (/^(?:物业)?报修(?:一下|工单)?[。！!？?]?$/.test(normalized)) return true;
  return /(?:我要|我想|需要|帮我|请|申请|提交|发起|进行|想要).{0,10}(?:物业)?报修/.test(normalized);
}

function explicitAutoSubmit(text: string): boolean {
  return /(?:直接|立即|马上|自动)提交|无需(?:再次)?确认|不用(?:再次)?确认/.test(text);
}

function isConfirmation(text: string): boolean {
  return /^(?:确认(?:提交)?|提交(?:吧|工单)?|可以提交|没问题|信息无误|是的)[。！!\s]*$/.test(text.trim());
}

function isCancellation(text: string): boolean {
  return /^(?:取消|取消报修|不报了|暂不提交|不用了)[。！!\s]*$/.test(text.trim());
}

function extractLabeledValue(text: string, labels: string[]): string {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const match = text.match(new RegExp(`(?:${escaped})[：:\\s]+([^，,。；;\\n]+)`));
  return clean(match?.[1]);
}

function extractCategory(text: string): string {
  const explicit = extractLabeledValue(text, ['报修类别', '维修类别', '类别']);
  if (explicit) return explicit;
  if (/灯|照明/.test(text)) return '灯具维修';
  if (/配电|插座|电路|跳闸|没电|断电/.test(text)) return '配电维修';
  if (/空调|暖气|暖通|通风|制冷|制热/.test(text)) return '暖通维修';
  if (/网络|断网|宽带|电话|固话|网线/.test(text)) return '网络、电话故障维修';
  if (/车牌|车辆信息/.test(text)) return '园区车辆车牌变更';
  return '';
}

function extractUrgency(text: string): string {
  const explicit = extractLabeledValue(text, ['紧急程度', '优先级']);
  if (explicit && REPAIR_URGENCIES.some((value) => explicit.includes(value))) {
    return REPAIR_URGENCIES.find((value) => explicit.includes(value)) ?? '';
  }
  if (/影响办公|无法办公|不能办公/.test(text)) return '影响办公';
  if (/紧急|着急|马上|立即|尽快|漏水|冒烟|火花/.test(text)) return '紧急';
  if (/普通|不急|一般/.test(text)) return '普通';
  return '';
}

function extractRoomNumber(text: string): string {
  const explicit = extractLabeledValue(text, ['房间号', '房号', '门牌号', '报修位置', '位置', '地点']);
  if (explicit) return explicit;
  const room = text.match(/(?:[A-Za-zＡ-Ｚａ-ｚ]\s*座\s*)?\d{2,5}\s*(?:室|房间)/i);
  return clean(room?.[0]).replace(/\s+/g, '');
}

function extractIssue(text: string): string {
  const explicit = extractLabeledValue(text, ['故障描述', '故障现象', '问题描述']);
  if (explicit) return explicit;
  if (!/(?:不亮|坏了|损坏|故障|漏水|断网|没电|断电|跳闸|异响|堵塞|无法|不能|失灵|不制冷|不制热|断连|冒烟|火花)/.test(text)) {
    return '';
  }
  return clean(text)
    .replace(/(?:我要|我想|需要|帮我|请)?(?:物业)?报修(?:一下|工单)?[，,。；;\s]*/g, '')
    .replace(/(?:信息齐了)?(?:直接|立即|马上|自动)提交/g, '')
    .replace(/[，,；;\s]*(?:普通|紧急|影响办公)[。！!\s]*$/g, '')
    .trim();
}

function applyText(fields: RepairModuleFields, text: string): RepairModuleFields {
  const contact = extractLabeledValue(text, ['联系人', '联系人员']);
  const phone = text.match(/(?<!\d)1[3-9]\d{9}(?!\d)/)?.[0]
    ?? extractLabeledValue(text, ['联系电话', '手机号', '手机']);
  const roomNumber = extractRoomNumber(text);
  const category = extractCategory(text);
  const issue = extractIssue(text);
  const urgency = extractUrgency(text);
  return {
    // 企业身份来自当前已认证账号，不接受会话文本覆盖，避免表单冒充其他企业。
    company: fields.company,
    roomNumber: roomNumber || fields.roomNumber,
    contact: contact || fields.contact,
    phone: phone ? normalizePhone(phone) : fields.phone,
    category: category || fields.category,
    issue: issue || fields.issue,
    urgency: urgency || fields.urgency,
  };
}

function missingFields(fields: RepairModuleFields): Array<keyof RepairModuleFields> {
  return REPAIR_REQUIRED_FIELDS.filter((field) => !clean(fields[field]));
}

function maskPhone(phone: string): string {
  const normalized = normalizePhone(phone);
  if (normalized.length < 7) return normalized;
  return `${normalized.slice(0, 3)}****${normalized.slice(-4)}`;
}

function acquiredLabels(fields: RepairModuleFields): string[] {
  return REPAIR_REQUIRED_FIELDS
    .filter((field) => clean(fields[field]))
    .map((field) => REPAIR_FIELD_LABELS[field]);
}

function humanList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join('、')}和${items.at(-1)}`;
}

function collectionMessage(fields: RepairModuleFields): string {
  const missing = missingFields(fields);
  const acquired = acquiredLabels(fields);
  const acquiredCopy = acquired.length
    ? `已获取${humanList(acquired)}。`
    : '';
  const missingCopy = missing.map((field) => REPAIR_FIELD_LABELS[field]).join('、');
  return `${acquiredCopy}请补充${missingCopy}。紧急程度可以填写“普通”“紧急”或“影响办公”。`;
}

function confirmationMessage(fields: RepairModuleFields): string {
  return [
    '报修信息已经完整，请确认：',
    '',
    `> ${fields.roomNumber}，${fields.category}，${fields.issue}，${fields.urgency}。联系人${fields.contact}，${maskPhone(fields.phone)}。`,
    '',
    '回复“确认提交”后，我会创建工单并发送给物业维修人员；回复“取消”可放弃本次报修。',
  ].join('\n');
}

function createDraft(input: PrepareModuleActionInput): ModuleActionDraft {
  const now = input.now ?? Date.now();
  const initialFields: RepairModuleFields = {
    company: clean(input.defaults.company),
    roomNumber: clean(input.defaults.roomNumber),
    contact: clean(input.defaults.contact),
    phone: normalizePhone(clean(input.defaults.phone)),
    category: '',
    issue: '',
    urgency: '',
  };
  const fields = applyText(initialFields, input.text);
  const complete = missingFields(fields).length === 0;
  return {
    id: `park-repair:${input.accountId}:${input.sessionId}:${now}`,
    idempotencyKey: `repair:${globalThis.crypto.randomUUID()}`,
    moduleId: 'park-repair',
    sessionId: input.sessionId,
    accountId: input.accountId,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + MODULE_ACTION_DRAFT_TTL_MS,
    phase: complete ? 'awaiting_confirmation' : 'collecting',
    autoSubmit: explicitAutoSubmit(input.text),
    fields,
  };
}

export function prepareModuleAction(
  input: PrepareModuleActionInput,
): ModuleActionTransition | null {
  if (!repairIntent(input.text)) return null;
  const draft = createDraft(input);
  const shouldSubmit = draft.autoSubmit && missingFields(draft.fields).length === 0;
  return {
    draft,
    shouldSubmit,
    assistantMessage: shouldSubmit
      ? '报修信息已完整，正在按你的要求直接提交。'
      : draft.phase === 'awaiting_confirmation'
        ? confirmationMessage(draft.fields)
        : collectionMessage(draft.fields),
  };
}

export function updateModuleDraft(
  current: ModuleActionDraft,
  text: string,
  now: number = Date.now(),
): ModuleActionTransition {
  if (isCancellation(text)) {
    return {
      draft: null,
      shouldSubmit: false,
      cancelled: true,
      assistantMessage: '已取消本次物业报修，信息不会发送给物业人员。',
    };
  }

  if (current.expiresAt <= now) {
    return {
      draft: null,
      shouldSubmit: false,
      assistantMessage: '这份物业报修草稿已超时失效，请重新说“我要物业报修”。',
    };
  }

  const fields = applyText(current.fields, text);
  const complete = missingFields(fields).length === 0;
  const draft: ModuleActionDraft = {
    ...current,
    fields,
    autoSubmit: current.autoSubmit || explicitAutoSubmit(text),
    phase: complete ? 'awaiting_confirmation' : 'collecting',
    updatedAt: now,
    expiresAt: now + MODULE_ACTION_DRAFT_TTL_MS,
  };
  const shouldSubmit = complete && (draft.autoSubmit || isConfirmation(text));

  return {
    draft,
    shouldSubmit,
    assistantMessage: shouldSubmit
      ? '正在提交物业报修工单。'
      : complete
        ? confirmationMessage(fields)
        : collectionMessage(fields),
  };
}

function ticketInput(draft: ModuleActionDraft): RepairTicketSubmitInput {
  const missing = missingFields(draft.fields);
  if (missing.length > 0) {
    throw new Error(`报修信息不完整：${missing.map((field) => REPAIR_FIELD_LABELS[field]).join('、')}`);
  }
  const fields = draft.fields;
  if (fields.issue.length > 2_000) {
    throw new Error('故障描述过长，请控制在 2000 字以内');
  }
  const input: RepairTicketSubmitInput = {
    idempotencyKey: draft.idempotencyKey,
    serviceId: 'repair',
    title: `${fields.roomNumber} · ${fields.category}报修`,
    description: fields.issue,
    formData: { ...fields },
    category: fields.category,
    location: fields.roomNumber,
    urgency: fields.urgency,
    contact: fields.contact,
    contactPhone: fields.phone,
  };
  if (input.title.length > 200) {
    throw new Error('报修位置或类别过长，请精简后重试');
  }
  return input;
}

export async function submitModuleAction(
  draft: ModuleActionDraft,
  executor: (input: RepairTicketSubmitInput) => Promise<RepairTicketSubmitResult>,
): Promise<{ ticket: RepairTicketSubmitResult; assistantMessage: string }> {
  const ticket = await executor(ticketInput(draft));
  const number = clean(ticket.applicationNumber) || ticket.id.slice(-8).toUpperCase();
  const recipients = ticket.recipients.map((recipient) => recipient.name).filter(Boolean);
  const recipientCopy = recipients.length
    ? recipients.join('、')
    : `${Math.max(1, ticket.recipientCount)} 位物业维修人员`;
  return {
    ticket,
    assistantMessage: `物业报修工单 **${number}** 已创建，并已发送给 **${recipientCopy}**。当前状态：${ticket.status}。你可以在右侧“物业报修”模块查看处理进度。`,
  };
}

export class ModuleActionDraftRegistry {
  private readonly drafts = new Map<string, ModuleActionDraft>();
  private readonly submitting = new Set<string>();
  private saveCount = 0;

  private key(sessionId: string, accountId: string): string {
    return `${accountId}:${sessionId}`;
  }

  get(sessionId: string, accountId: string, now: number = Date.now()): ModuleActionDraft | null {
    const key = this.key(sessionId, accountId);
    const draft = this.drafts.get(key);
    if (!draft) return null;
    if (
      draft.sessionId !== sessionId
      || draft.accountId !== accountId
      || draft.expiresAt <= now
    ) {
      this.drafts.delete(key);
      return null;
    }
    return draft;
  }

  save(draft: ModuleActionDraft): void {
    const key = this.key(draft.sessionId, draft.accountId);
    this.saveCount += 1;
    if (this.saveCount % 256 === 0 || this.drafts.size >= MAX_MODULE_ACTION_DRAFTS) {
      this.pruneExpired(draft.updatedAt);
    }
    // Map 的插入顺序用作低成本 LRU：更新草稿时把它移到末尾。
    this.drafts.delete(key);
    this.drafts.set(key, draft);
    while (this.drafts.size > MAX_MODULE_ACTION_DRAFTS) {
      const oldest = this.drafts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.drafts.delete(oldest);
      this.submitting.delete(oldest);
    }
  }

  clear(sessionId: string, accountId: string): void {
    this.drafts.delete(this.key(sessionId, accountId));
  }

  summary(
    sessionId: string,
    accountId: string,
    now: number = Date.now(),
  ): ConversationActionDraftSummary | null {
    const draft = this.get(sessionId, accountId, now);
    if (!draft) return null;
    const missing = missingFields(draft.fields).map((field) => REPAIR_FIELD_LABELS[field]);
    const submitting = this.submitting.has(this.key(sessionId, accountId));
    return {
      id: draft.id,
      source: 'repair',
      title: '物业报修',
      phase: submitting ? 'submitting' : draft.phase,
      updatedAt: draft.updatedAt,
      expiresAt: draft.expiresAt,
      missingFields: missing,
      ...(!submitting && missing.length === 0 ? { confirmationText: '确认提交' } : {}),
    };
  }

  discard(id: string, sessionId: string, accountId: string, now: number = Date.now()): boolean {
    const draft = this.get(sessionId, accountId, now);
    if (!draft || draft.id !== id) return false;
    if (this.submitting.has(this.key(sessionId, accountId))) return false;
    this.clear(sessionId, accountId);
    this.submitting.delete(this.key(sessionId, accountId));
    return true;
  }

  beginSubmission(sessionId: string, accountId: string): boolean {
    const key = this.key(sessionId, accountId);
    if (this.submitting.has(key)) return false;
    this.submitting.add(key);
    return true;
  }

  finishSubmission(sessionId: string, accountId: string): void {
    this.submitting.delete(this.key(sessionId, accountId));
  }

  activeDraftCount(now: number = Date.now()): number {
    this.pruneExpired(now);
    return this.drafts.size;
  }

  snapshot(accountId: string, now: number = Date.now()): ModuleActionDraft[] {
    this.pruneExpired(now);
    return [...this.drafts.values()].filter((draft) => draft.accountId === accountId);
  }

  restore(accountId: string, payload: unknown, now: number = Date.now()): number {
    if (!Array.isArray(payload)) return 0;
    let restored = 0;
    for (const raw of payload.slice(0, MAX_MODULE_ACTION_DRAFTS)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const draft = raw as Partial<ModuleActionDraft>;
      if (
        typeof draft.id !== 'string'
        || draft.moduleId !== 'park-repair'
        || typeof draft.sessionId !== 'string'
        || draft.sessionId.length > 500
        || draft.accountId !== accountId
        || typeof draft.createdAt !== 'number'
        || typeof draft.updatedAt !== 'number'
        || typeof draft.expiresAt !== 'number'
        || draft.expiresAt <= now
        || !['collecting', 'awaiting_confirmation'].includes(String(draft.phase))
        || typeof draft.autoSubmit !== 'boolean'
        || !draft.fields
        || typeof draft.fields !== 'object'
        || Array.isArray(draft.fields)
      ) continue;
      const fields = draft.fields as Partial<RepairModuleFields>;
      if (REPAIR_REQUIRED_FIELDS.some((field) => typeof fields[field] !== 'string')) continue;
      this.save(draft as ModuleActionDraft);
      restored += 1;
    }
    return restored;
  }

  private pruneExpired(now: number): void {
    for (const [key, draft] of this.drafts) {
      if (draft.expiresAt > now) continue;
      this.drafts.delete(key);
      this.submitting.delete(key);
    }
  }
}

export async function handleModuleActionConversation(
  input: HandleModuleActionConversationInput,
): Promise<boolean> {
  if (!input.enabled || !input.text.trim()) return false;
  const now = input.now?.() ?? Date.now();
  const existing = input.registry.get(input.sessionId, input.accountId, now);
  if (input.expectedDraftId && existing?.id !== input.expectedDraftId) {
    input.postMessage('assistant', '该物业报修草稿已变化或过期，本次没有提交。请检查当前草稿后重新确认。');
    return true;
  }
  if (!existing && !repairIntent(input.text)) return false;

  input.postMessage('user', input.text.trim());
  let transition: ModuleActionTransition | null;
  if (existing) {
    transition = updateModuleDraft(existing, input.text, now);
  } else {
    try {
      transition = prepareModuleAction({
        text: input.text,
        sessionId: input.sessionId,
        accountId: input.accountId,
        defaults: await input.loadDefaults(),
        now,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '企业资料读取失败';
      input.postMessage('assistant', `暂时无法读取物业报修所需的企业资料：${message}`);
      return true;
    }
  }
  if (!transition) return false;

  if (!transition.draft) {
    input.registry.clear(input.sessionId, input.accountId);
    input.postMessage('assistant', transition.assistantMessage);
    return true;
  }

  input.registry.save(transition.draft);
  if (!transition.shouldSubmit) {
    input.postMessage('assistant', transition.assistantMessage);
    return true;
  }

  if (!input.registry.beginSubmission(input.sessionId, input.accountId)) {
    input.postMessage('assistant', '物业报修工单正在提交，请勿重复操作。');
    return true;
  }

  try {
    const submitted = await submitModuleAction(transition.draft, input.submit);
    input.registry.clear(input.sessionId, input.accountId);
    try {
      input.onSubmitted?.(submitted.ticket, transition.draft);
    } catch {
      // 会话进展关联是本地辅助能力，失败不能把已成功创建的工单误报为失败并诱发重提。
    }
    input.postMessage('assistant', submitted.assistantMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    input.postMessage(
      'assistant',
      `物业报修暂未提交成功：${message}。草稿已保留，你可以稍后回复“确认提交”重试，或回复“取消”。`,
    );
  } finally {
    input.registry.finishSubmission(input.sessionId, input.accountId);
  }
  return true;
}
