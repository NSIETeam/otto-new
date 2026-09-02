/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  serviceFormDisplayValue,
  serviceFormFields,
  serviceOptionLabel,
  serviceOptionValue,
  type ParkServiceFormField,
} from './parkServiceFormSchema.js';
import type { ConversationActionDraftSummary } from './conversationActionDraft.js';

export const PARK_SERVICE_ACTION_TTL_MS = 30 * 60 * 1_000;
const MAX_DRAFTS = 10_000;
const MAX_FIELD_LENGTH = 2_000;

export type ConversationalParkServiceId =
  | 'renovation'
  | 'parking'
  | 'network-phone'
  | 'meeting-room'
  | 'electric-card'
  | 'vehicle-visit';

export interface ParkServiceDefaults {
  company: string;
  roomNumber: string;
  contact: string;
  phone: string;
}

export interface ParkServiceTicketSubmitInput {
  idempotencyKey: string;
  serviceId: ConversationalParkServiceId;
  title: string;
  description: string;
  formData: Record<string, string>;
  contact: string;
  contactPhone: string;
}

export interface ParkServiceTicketSubmitResult {
  id: string;
  applicationNumber?: string | null;
  status: string;
  recipients: Array<{ id: string; name: string }>;
  recipientCount: number;
}

export interface ParkMeetingResources {
  settings: { parkingTotal: number; parkingNote: string | null; updatedAt: string };
  meetingRooms: Array<{
    id: string;
    name: string;
    location: string;
    capacity: number;
    priceHalfDay: number;
    equipment: string[];
    enabled: boolean;
  }>;
  meetingSlots: Array<{
    id: string;
    roomId: string;
    date: string;
    slotKey: string;
    label: string;
    status: 'available' | 'booked' | 'closed';
  }>;
}

interface SurveyPublication {
  id: string;
  kind: 'announcement' | 'satisfaction';
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  submittedAt: string | null;
  responseData: Record<string, string> | null;
}

interface BaseDraft {
  id: string;
  sessionId: string;
  accountId: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  phase: 'collecting' | 'awaiting_confirmation';
}

export interface ParkTicketActionDraft extends BaseDraft {
  kind: 'ticket';
  serviceId: ConversationalParkServiceId;
  idempotencyKey: string;
  fields: Record<string, string>;
  availabilityError?: string;
}

export interface ParkSurveyActionDraft extends BaseDraft {
  kind: 'survey';
  surveyId: string;
  surveyTitle: string;
  surveyBody: string;
  fields: Record<string, string>;
}

export type ParkServiceActionDraft = ParkTicketActionDraft | ParkSurveyActionDraft;

export interface ParkServiceActionConversationInput {
  text: string;
  sessionId: string;
  accountId: string;
  enabled: boolean;
  registry: ParkServiceActionDraftRegistry;
  loadDefaults(): Promise<ParkServiceDefaults>;
  loadMeetingResources(): Promise<ParkMeetingResources>;
  listPublications(): Promise<SurveyPublication[]>;
  submitTicket(input: ParkServiceTicketSubmitInput): Promise<ParkServiceTicketSubmitResult>;
  onTicketSubmitted?(ticket: ParkServiceTicketSubmitResult, draft: ParkTicketActionDraft): void;
  submitSurvey(id: string, responseData: Record<string, string>): Promise<{ id: string; submittedAt: string | null }>;
  postMessage(role: 'user' | 'assistant', text: string): void;
  /** UI 草稿中心确认时必须绑定当前展示的草稿，拒绝串单或过期确认。 */
  expectedDraftId?: string;
  now?: () => number;
}

const SERVICE_NAMES: Readonly<Record<ConversationalParkServiceId, string>> = {
  renovation: '装修管理',
  parking: '停车办理',
  'network-phone': '网络与固话',
  'meeting-room': '会议室预约',
  'electric-card': '电卡服务',
  'vehicle-visit': '车辆与访客',
};

function clean(value: unknown): string {
  return typeof value === 'string'
    ? Array.from(value.trim()).slice(0, MAX_FIELD_LENGTH).join('')
    : '';
}

function normalizePhone(value: string): string {
  return value.replace(/^\+86/u, '').replace(/[\s-]/gu, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function labeledValue(text: string, labels: readonly string[]): string {
  const pattern = labels.map(escapeRegExp).join('|');
  const match = text.match(new RegExp(`(?:${pattern})[：:\\s]+([^，,。；;\\n]+)`, 'u'));
  return clean(match?.[1]);
}

function normalizeDate(value: string): string {
  const match = value.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/u);
  if (!match) return '';
  const month = String(Number(match[2])).padStart(2, '0');
  const day = String(Number(match[3])).padStart(2, '0');
  const normalized = `${match[1]}-${month}-${day}`;
  const date = new Date(`${normalized}T00:00:00+08:00`);
  return Number.isNaN(date.getTime()) ? '' : normalized;
}

function extractDate(text: string, labels: readonly string[]): string {
  return normalizeDate(labeledValue(text, labels)) || normalizeDate(text);
}

function normalizeTime(value: string): string {
  const match = value.match(/(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)(?:\D|$)/u);
  return match ? `${String(Number(match[1])).padStart(2, '0')}:${match[2]}` : '';
}

function extractTimeRange(text: string): { startTime: string; endTime: string } | null {
  const match = text.match(/([01]?\d|2[0-3]):([0-5]\d)\s*(?:-|–|—|至|到)\s*([01]?\d|2[0-3]):([0-5]\d)/u);
  if (!match) return null;
  return {
    startTime: `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`,
    endTime: `${String(Number(match[3])).padStart(2, '0')}:${match[4]}`,
  };
}

function numberValue(text: string, labels: readonly string[], suffix?: RegExp): string {
  const explicit = labeledValue(text, labels);
  if (explicit) return clean(explicit.match(/(-?\d+(?:\.\d+)?)/u)?.[1]);
  if (!suffix) return '';
  return clean(text.match(suffix)?.[1]);
}

function optionFromText(field: ParkServiceFormField, text: string): string {
  const explicit = labeledValue(text, [field.label, field.key]);
  const source = explicit || text;
  const option = field.options?.find((candidate) => {
    const value = serviceOptionValue(candidate);
    const label = serviceOptionLabel(candidate).split('·')[0]?.trim() ?? '';
    return source.includes(value) || (label.length >= 2 && source.includes(label));
  });
  if (option) return serviceOptionValue(option);
  if (field.key === 'applicationType') {
    if (/地下固定子母/u.test(source)) return 'underground-tandem';
    if (/地下固定/u.test(source)) return 'underground-fixed';
    if (/地上临时/u.test(source)) return 'surface-temporary';
    if (/地下临时/u.test(source)) return 'underground-temporary';
    if (/退(?:办|停车位)|取消停车位/u.test(source)) return 'cancel';
  }
  const networkOptions: Array<[RegExp, string]> = [
    [/来电显示/u, 'caller-id'], [/停机保号/u, 'number-hold'], [/固话停机/u, 'landline-stop'],
    [/开通(?:固话|电话)|电话开通/u, 'phone-open'], [/15\s*[mM]/u, 'leased-line-15'],
    [/30\s*[mM]/u, 'leased-line-30'], [/45\s*[mM]/u, 'leased-line-45'], [/75\s*[mM]/u, 'leased-line-75'],
  ];
  if (field.key === 'businessType') {
    return networkOptions.find(([pattern]) => pattern.test(source))?.[1] ?? '';
  }
  return '';
}

function initialFields(defaults: ParkServiceDefaults): Record<string, string> {
  return {
    company: clean(defaults.company),
    roomNumber: clean(defaults.roomNumber),
    contact: clean(defaults.contact),
    phone: normalizePhone(clean(defaults.phone)),
  };
}

function applyTicketText(
  serviceId: ConversationalParkServiceId,
  current: Record<string, string>,
  text: string,
): Record<string, string> {
  const next = { ...current };
  const schema = serviceFormFields(serviceId);
  for (const field of schema) {
    // Server-authenticated identity wins over free-form conversation text.
    if (['company', 'roomNumber', 'contact', 'phone'].includes(field.key)) continue;
    let value = '';
    if (field.options) value = optionFromText(field, text);
    else if (field.key === 'area') {
      value = labeledValue(text, ['装修区域', '区域', '施工区域'])
        || clean(text.match(/(?:[A-Za-zＡ-Ｚａ-ｚ]\s*座\s*)?\d{2,5}\s*(?:室|房间)/iu)?.[0]).replace(/\s+/gu, '');
    } else if (field.key === 'startDate') value = extractDate(text, ['计划开工日期', '开工日期']);
    else if (field.key === 'expectedDate') value = extractDate(text, ['期望开通日期', '开通日期']);
    else if (field.key === 'visitDate') value = extractDate(text, ['来访日期', '访问日期']);
    else if (field.key === 'visitTime') value = normalizeTime(labeledValue(text, ['具体来访时间', '来访时间', '访问时间']));
    else if (field.key === 'quantity') value = numberValue(text, ['申请数量', '数量'], /(?:申请)?数量[：:\s]*(\d+)/u);
    else if (field.key === 'chargingKwh') value = numberValue(text, ['充电度数', '度数'], /(\d+(?:\.\d+)?)\s*度/u);
    else if (field.key === 'vehicleCount') value = numberValue(text, ['来访车辆数量', '车辆数量'], /(?:来访)?车辆数量[：:\s]*(\d+)/u);
    else if (field.key === 'attendees') value = numberValue(text, ['参会人数', '人数'], /(\d+)\s*人/u);
    else if (field.key === 'meetingContent') value = labeledValue(text, ['会议内容', '会议主题', '主题']);
    else if (field.key === 'reason') value = labeledValue(text, ['拜访企业及事由', '拜访事由', '来访事由', '事由']);
    else value = labeledValue(text, [field.label, field.key]);
    if (value) next[field.key] = value;
  }

  if (serviceId === 'meeting-room') {
    const date = extractDate(text, ['使用日期', '预约日期', '会议日期', '日期']);
    const time = extractTimeRange(text);
    const roomName = labeledValue(text, ['会议室', '会议室名称']);
    if (date) next.date = date;
    if (time) Object.assign(next, time);
    if (roomName) next.roomName = roomName;
  }

  if (serviceId === 'vehicle-visit') {
    const plates = [...text.matchAll(/[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-Z][A-Z0-9]{5,6}/giu)]
      .map((match) => match[0].toUpperCase());
    plates.forEach((plate, index) => { next[`vehiclePlate${index + 1}`] = plate; });
  }
  return next;
}

function applySurveyText(current: Record<string, string>, text: string): Record<string, string> {
  const score = labeledValue(text, ['总体满意度', '满意度', '评分'])
    .match(/[1-5]/u)?.[0] ?? text.match(/([1-5])\s*分/u)?.[1] ?? '';
  return {
    ...current,
    ...(score ? { score } : {}),
    ...(labeledValue(text, ['重点关注', '关注点']) ? { focus: labeledValue(text, ['重点关注', '关注点']) } : {}),
    ...(labeledValue(text, ['改进建议', '建议', '反馈']) ? { feedback: labeledValue(text, ['改进建议', '建议', '反馈']) } : {}),
  };
}

function invalidNumber(field: ParkServiceFormField, value: string): boolean {
  if (field.inputType !== 'number' || !value) return false;
  const number = Number(value);
  return !Number.isFinite(number)
    || (field.min !== undefined && number < field.min)
    || (field.max !== undefined && number > field.max)
    || (field.key !== 'chargingKwh' && !Number.isInteger(number));
}

function ticketMissing(draft: ParkTicketActionDraft): string[] {
  const fields = serviceFormFields(draft.serviceId);
  const missing = fields.filter((field) => !clean(draft.fields[field.key]) || invalidNumber(field, draft.fields[field.key] ?? ''))
    .map((field) => field.label);
  if (draft.serviceId === 'vehicle-visit') {
    const count = Math.max(0, Math.min(20, Number(draft.fields.vehicleCount) || 0));
    for (let index = 1; index <= count; index += 1) {
      if (!clean(draft.fields[`vehiclePlate${index}`])) missing.push(`第${index}辆车牌号`);
    }
  }
  if (draft.serviceId === 'meeting-room') {
    const extra: Array<[string, string]> = [
      ['date', '使用日期'], ['startTime', '开始时间'], ['endTime', '结束时间'], ['roomId', '可用会议室'],
    ];
    extra.forEach(([key, label]) => { if (!clean(draft.fields[key])) missing.push(label); });
  }
  return [...new Set(missing)];
}

function surveyMissing(draft: ParkSurveyActionDraft): string[] {
  return [
    ['company', '公司名称'], ['roomNumber', '房间号'], ['contact', '联系人'], ['phone', '联系电话'],
    ['score', '总体满意度（1—5分）'], ['focus', '重点关注'], ['feedback', '改进建议'],
  ].filter(([key]) => !clean(draft.fields[key])).map(([, label]) => label);
}

function minutes(value: string): number {
  const match = value.match(/^(\d{2}):(\d{2})$/u);
  return match ? Number(match[1]) * 60 + Number(match[2]) : -1;
}

function slotKeys(startTime: string, endTime: string): string[] {
  const start = minutes(startTime);
  const end = minutes(endTime);
  if (start < 0 || end <= start || start % 30 !== 0 || end % 30 !== 0) return [];
  const keys: string[] = [];
  for (let current = start; current < end; current += 30) {
    keys.push(`${String(Math.floor(current / 60)).padStart(2, '0')}:${String(current % 60).padStart(2, '0')}`);
  }
  return keys;
}

function resolveMeeting(
  draft: ParkTicketActionDraft,
  resources: ParkMeetingResources,
  now: number,
): ParkTicketActionDraft {
  const fields = { ...draft.fields };
  delete fields.roomId;
  delete fields.roomCapacity;
  delete fields.priceHalfDay;
  delete fields.time;
  const attendees = Number(fields.attendees);
  const slots = slotKeys(fields.startTime ?? '', fields.endTime ?? '');
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now));
  if (fields.date && fields.date < today) {
    return { ...draft, fields, availabilityError: '会议室不能预约过去日期' };
  }
  if (!fields.date || !Number.isInteger(attendees) || attendees < 1 || slots.length === 0) {
    return { ...draft, fields, availabilityError: undefined };
  }
  const requestedRoom = clean(fields.roomName);
  const candidates = resources.meetingRooms
    .filter((room) => room.enabled && room.capacity >= attendees)
    .filter((room) => !requestedRoom || room.name.includes(requestedRoom) || requestedRoom.includes(room.name))
    .filter((room) => slots.every((slotKey) => resources.meetingSlots.some((slot) => (
      slot.roomId === room.id
      && slot.date === fields.date
      && slot.slotKey === slotKey
      && slot.status === 'available'
    ))))
    .sort((left, right) => left.capacity - right.capacity || left.priceHalfDay - right.priceHalfDay);
  const room = candidates[0];
  if (!room) {
    return {
      ...draft,
      fields,
      availabilityError: `${fields.date} ${fields.startTime}-${fields.endTime} 没有连续可用且满足 ${attendees} 人的会议室，请更换时间或人数。`,
    };
  }
  return {
    ...draft,
    fields: {
      ...fields,
      roomId: room.id,
      roomName: room.name,
      roomCapacity: String(room.capacity),
      priceHalfDay: String(room.priceHalfDay),
      time: `${fields.startTime}-${fields.endTime}`,
    },
    availabilityError: undefined,
  };
}

function parkIntent(text: string): ConversationalParkServiceId | 'satisfaction' | null {
  const normalized = text.trim();
  if (!normalized || /(?:不想|不要|不用|取消).{0,8}(?:申请|办理|预约|提交|填写)/u.test(normalized)) return null;
  if (/(?:怎么用|如何使用|是什么|介绍|功能)/u.test(normalized)) return null;
  if (/(?:满意度调查|填写问卷|服务评价)/u.test(normalized) && /(?:填|提交|参加|评价)/u.test(normalized)) return 'satisfaction';
  if (/(?:预约|预订|订).{0,6}会议室|会议室预约/u.test(normalized)) return 'meeting-room';
  if (/(?:装修申请|申请装修|提交装修|装修管理)/u.test(normalized)) return 'renovation';
  if (/(?:停车位|停车办理)/u.test(normalized) && /(?:申请|办理|续办|退|需要|要)/u.test(normalized)) return 'parking';
  if (/(?:电卡|充电度数)/u.test(normalized) && /(?:办理|申请|充|提交|需要|要)/u.test(normalized)) return 'electric-card';
  if (/(?:车辆与访客|访客登记|车辆登记|来访登记|登记访客)/u.test(normalized)) return 'vehicle-visit';
  if (!/(?:故障|断网|报修)/u.test(normalized)
    && /(?:网络|固话|电话|专线|来电显示|停机保号)/u.test(normalized)
    && /(?:开通|办理|申请|停机|需要|要)/u.test(normalized)) return 'network-phone';
  return null;
}

function baseDraft(input: {
  kind: 'ticket' | 'survey'; sessionId: string; accountId: string; now: number;
}): BaseDraft {
  return {
    id: `${input.kind}:${input.accountId}:${input.sessionId}:${input.now}`,
    sessionId: input.sessionId,
    accountId: input.accountId,
    createdAt: input.now,
    updatedAt: input.now,
    expiresAt: input.now + PARK_SERVICE_ACTION_TTL_MS,
    phase: 'collecting',
  };
}

function maskedPhone(phone: string): string {
  const value = normalizePhone(phone);
  return value.length >= 7 ? `${value.slice(0, 3)}****${value.slice(-4)}` : value;
}

function fieldSummary(draft: ParkTicketActionDraft): string[] {
  const lines = serviceFormFields(draft.serviceId).map((field) => {
    const value = draft.fields[field.key] ?? '';
    return `- ${field.label}：${field.key === 'phone' ? maskedPhone(value) : serviceFormDisplayValue(field, value)}`;
  });
  if (draft.serviceId === 'vehicle-visit') {
    const count = Number(draft.fields.vehicleCount) || 0;
    for (let index = 1; index <= count; index += 1) lines.push(`- 第${index}辆车牌号：${draft.fields[`vehiclePlate${index}`]}`);
  }
  if (draft.serviceId === 'electric-card') {
    lines.push(`- 预计金额：${(Number(draft.fields.chargingKwh) * 1.2).toFixed(2)} 元`);
  }
  if (draft.serviceId === 'meeting-room') {
    const duration = minutes(draft.fields.endTime) - minutes(draft.fields.startTime);
    const units = Math.max(1, Math.ceil(duration / 240));
    const estimated = units * Number(draft.fields.priceHalfDay || 0);
    lines.push(
      `- 会议室：${draft.fields.roomName}（最多 ${draft.fields.roomCapacity} 人）`,
      `- 使用日期与时间：${draft.fields.date} ${draft.fields.startTime}-${draft.fields.endTime}`,
      `- 预计金额：${estimated.toFixed(2)} 元`,
    );
  }
  return lines;
}

function collectionMessage(draft: ParkServiceActionDraft): string {
  const missing = draft.kind === 'ticket' ? ticketMissing(draft) : surveyMissing(draft);
  const prefix = draft.kind === 'ticket'
    ? `${SERVICE_NAMES[draft.serviceId]}申请草稿已建立。`
    : `正在填写“${draft.surveyTitle}”。`;
  const error = draft.kind === 'ticket' && draft.availabilityError ? `${draft.availabilityError}\n\n` : '';
  return `${prefix}${error}\n\n请补充：${missing.join('、')}。可以按“字段名：内容”的形式一次填写多项。`;
}

function confirmationMessage(draft: ParkServiceActionDraft): string {
  if (draft.kind === 'survey') {
    return [
      `“${draft.surveyTitle}”已填写完整：`, '',
      `- 总体满意度：${draft.fields.score} 分`,
      `- 重点关注：${draft.fields.focus}`,
      `- 改进建议：${draft.fields.feedback}`,
      '', '满意度调查实名提交后不能修改。回复“确认提交”后正式提交，回复“取消”可放弃。',
    ].join('\n');
  }
  return [
    `${SERVICE_NAMES[draft.serviceId]}申请信息已完整：`, '',
    ...fieldSummary(draft), '',
    '回复“确认提交”后创建园区服务工单，回复“取消”可放弃。',
  ].join('\n');
}

function isConfirmation(text: string): boolean {
  return /^(?:确认提交|确认|提交|可以提交|信息无误)[。！!\s]*$/u.test(text.trim());
}

function isCancellation(text: string): boolean {
  return /^(?:取消|不办了|不提交了|放弃|不用了)[。！!\s]*$/u.test(text.trim());
}

function ticketInput(draft: ParkTicketActionDraft): ParkServiceTicketSubmitInput {
  const missing = ticketMissing(draft);
  if (missing.length > 0) throw new Error(`申请信息不完整：${missing.join('、')}`);
  const fields = { ...draft.fields };
  const name = SERVICE_NAMES[draft.serviceId];
  const primary = fields.roomName
    || serviceFormDisplayValue(serviceFormFields(draft.serviceId).find((field) => field.key === 'applicationType') ?? { key: '', label: '', placeholder: '' }, fields.applicationType ?? '')
    || fields.area || fields.businessType || fields.chargingKwh && `${fields.chargingKwh}度`
    || fields.visitDate || fields.roomNumber || name;
  const description = draft.serviceId === 'meeting-room'
    ? [
        `会议室：${fields.roomName}`, `使用日期：${fields.date}`,
        `使用时间：${fields.startTime}-${fields.endTime}`,
        `参会人数：${fields.attendees}`, `会议内容：${fields.meetingContent}`,
        `计费标准：${fields.priceHalfDay} 元/半天，不足半天按半天计`,
      ].join('\n')
    : fieldSummary(draft).filter((line) => !line.includes('预计金额')).join('\n');
  return {
    idempotencyKey: draft.idempotencyKey,
    serviceId: draft.serviceId,
    title: `${name} · ${primary}`.slice(0, 200),
    description: description.slice(0, 2_000),
    formData: fields,
    contact: fields.contact,
    contactPhone: fields.phone,
  };
}

export class ParkServiceActionDraftRegistry {
  private readonly drafts = new Map<string, ParkServiceActionDraft>();
  private readonly submitting = new Set<string>();

  private key(sessionId: string, accountId: string): string {
    return `${accountId}:${sessionId}`;
  }

  get(sessionId: string, accountId: string, now: number = Date.now()): ParkServiceActionDraft | null {
    const key = this.key(sessionId, accountId);
    const draft = this.drafts.get(key);
    if (!draft) return null;
    if (draft.accountId !== accountId || draft.sessionId !== sessionId || draft.expiresAt <= now) {
      this.drafts.delete(key);
      this.submitting.delete(key);
      return null;
    }
    return draft;
  }

  save(draft: ParkServiceActionDraft): void {
    const key = this.key(draft.sessionId, draft.accountId);
    this.drafts.delete(key);
    this.drafts.set(key, draft);
    while (this.drafts.size > MAX_DRAFTS) {
      const oldest = this.drafts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.drafts.delete(oldest);
      this.submitting.delete(oldest);
    }
  }

  clear(sessionId: string, accountId: string): void {
    const key = this.key(sessionId, accountId);
    this.drafts.delete(key);
    this.submitting.delete(key);
  }

  summary(
    sessionId: string,
    accountId: string,
    now: number = Date.now(),
  ): ConversationActionDraftSummary | null {
    const draft = this.get(sessionId, accountId, now);
    if (!draft) return null;
    const missing = draft.kind === 'ticket' ? ticketMissing(draft) : surveyMissing(draft);
    const submitting = this.submitting.has(this.key(sessionId, accountId));
    return {
      id: draft.id,
      source: 'park-service',
      title: draft.kind === 'ticket' ? `${SERVICE_NAMES[draft.serviceId]}申请` : draft.surveyTitle,
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

  snapshot(accountId: string, now: number = Date.now()): ParkServiceActionDraft[] {
    return [...this.drafts.values()].filter((draft) => {
      if (draft.expiresAt <= now) {
        this.clear(draft.sessionId, draft.accountId);
        return false;
      }
      return draft.accountId === accountId;
    });
  }

  restore(accountId: string, payload: unknown, now: number = Date.now()): number {
    if (!Array.isArray(payload)) return 0;
    let restored = 0;
    for (const raw of payload.slice(0, MAX_DRAFTS)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const draft = raw as Partial<ParkServiceActionDraft>;
      if (
        typeof draft.id !== 'string'
        || typeof draft.sessionId !== 'string'
        || draft.sessionId.length > 500
        || draft.accountId !== accountId
        || typeof draft.createdAt !== 'number'
        || typeof draft.updatedAt !== 'number'
        || typeof draft.expiresAt !== 'number'
        || draft.expiresAt <= now
        || !['collecting', 'awaiting_confirmation'].includes(String(draft.phase))
        || (draft.kind !== 'ticket' && draft.kind !== 'survey')
        || !draft.fields
        || typeof draft.fields !== 'object'
        || Array.isArray(draft.fields)
        || Object.values(draft.fields).some((value) => typeof value !== 'string')
      ) continue;
      if (draft.kind === 'ticket') {
        if (
          !draft.serviceId
          || !Object.hasOwn(SERVICE_NAMES, draft.serviceId)
          || typeof draft.idempotencyKey !== 'string'
        ) continue;
      } else {
        const survey = draft as Partial<ParkSurveyActionDraft>;
        if (
          typeof survey.surveyId !== 'string'
          || typeof survey.surveyTitle !== 'string'
          || typeof survey.surveyBody !== 'string'
        ) continue;
      }
      this.save(draft as ParkServiceActionDraft);
      restored += 1;
    }
    return restored;
  }
}

async function createDraft(
  input: ParkServiceActionConversationInput,
  intent: ConversationalParkServiceId | 'satisfaction',
  now: number,
): Promise<ParkServiceActionDraft | null> {
  const defaults = initialFields(await input.loadDefaults());
  if (intent === 'satisfaction') {
    const publication = (await input.listPublications())
      .filter((item) => item.kind === 'satisfaction' && !item.submittedAt)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
    if (!publication) return null;
    const draft: ParkSurveyActionDraft = {
      ...baseDraft({ kind: 'survey', sessionId: input.sessionId, accountId: input.accountId, now }),
      kind: 'survey', surveyId: publication.id, surveyTitle: clean(publication.title),
      surveyBody: clean(publication.body), fields: applySurveyText(defaults, input.text),
    };
    draft.phase = surveyMissing(draft).length ? 'collecting' : 'awaiting_confirmation';
    return draft;
  }
  let draft: ParkTicketActionDraft = {
    ...baseDraft({ kind: 'ticket', sessionId: input.sessionId, accountId: input.accountId, now }),
    kind: 'ticket', serviceId: intent, idempotencyKey: `park:${crypto.randomUUID()}`,
    fields: applyTicketText(intent, defaults, input.text),
  };
  if (intent === 'meeting-room') draft = resolveMeeting(draft, await input.loadMeetingResources(), now);
  draft.phase = ticketMissing(draft).length ? 'collecting' : 'awaiting_confirmation';
  return draft;
}

async function updateDraft(
  draft: ParkServiceActionDraft,
  text: string,
  input: ParkServiceActionConversationInput,
  now: number,
): Promise<ParkServiceActionDraft> {
  if (draft.kind === 'survey') {
    const next: ParkSurveyActionDraft = {
      ...draft, fields: applySurveyText(draft.fields, text), updatedAt: now,
      expiresAt: now + PARK_SERVICE_ACTION_TTL_MS,
    };
    next.phase = surveyMissing(next).length ? 'collecting' : 'awaiting_confirmation';
    return next;
  }
  let next: ParkTicketActionDraft = {
    ...draft, fields: applyTicketText(draft.serviceId, draft.fields, text), updatedAt: now,
    expiresAt: now + PARK_SERVICE_ACTION_TTL_MS,
  };
  if (next.serviceId === 'meeting-room') next = resolveMeeting(next, await input.loadMeetingResources(), now);
  next.phase = ticketMissing(next).length ? 'collecting' : 'awaiting_confirmation';
  return next;
}

function successMessage(ticket: ParkServiceTicketSubmitResult, serviceId: ConversationalParkServiceId): string {
  const number = clean(ticket.applicationNumber) || clean(ticket.id).slice(-8).toUpperCase();
  const recipients = ticket.recipients.map((item) => clean(item.name)).filter(Boolean).join('、');
  return `${SERVICE_NAMES[serviceId]}申请 **${number}** 已创建${recipients ? `，已发送给 **${recipients}**` : ''}。当前状态：${ticket.status}。右侧“我的申请”会同步显示进度。`;
}

export async function handleParkServiceActionConversation(
  input: ParkServiceActionConversationInput,
): Promise<boolean> {
  if (!input.enabled || !input.text.trim()) return false;
  const now = input.now?.() ?? Date.now();
  let draft = input.registry.get(input.sessionId, input.accountId, now);
  if (input.expectedDraftId && draft?.id !== input.expectedDraftId) {
    input.postMessage('assistant', '该园区服务草稿已变化或过期，本次没有提交。请检查当前草稿后重新确认。');
    return true;
  }
  const intent = draft ? null : parkIntent(input.text);
  if (!draft && !intent) return false;
  input.postMessage('user', input.text.trim());

  if (draft && isCancellation(input.text)) {
    input.registry.clear(input.sessionId, input.accountId);
    input.postMessage('assistant', '已取消本次园区服务草稿，信息不会提交给园区工作人员。');
    return true;
  }

  try {
    draft = draft
      ? await updateDraft(draft, input.text, input, now)
      : await createDraft(input, intent!, now);
  } catch (error) {
    input.postMessage('assistant', `暂时无法准备园区服务申请：${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
  if (!draft) {
    input.postMessage('assistant', '当前没有待填写的满意度调查。');
    return true;
  }
  input.registry.save(draft);
  const missing = draft.kind === 'ticket' ? ticketMissing(draft) : surveyMissing(draft);
  if (missing.length > 0 || !isConfirmation(input.text)) {
    input.postMessage('assistant', missing.length > 0 ? collectionMessage(draft) : confirmationMessage(draft));
    return true;
  }

  // A meeting may have been booked after the summary was shown. Re-check the
  // server resource snapshot immediately before the real write.
  if (draft.kind === 'ticket' && draft.serviceId === 'meeting-room') {
    draft = resolveMeeting(draft, await input.loadMeetingResources(), now);
    if (ticketMissing(draft).length > 0) {
      input.registry.save(draft);
      input.postMessage('assistant', collectionMessage(draft));
      return true;
    }
  }
  if (!input.registry.beginSubmission(input.sessionId, input.accountId)) {
    input.postMessage('assistant', '这项园区服务正在提交，请勿重复操作。');
    return true;
  }
  try {
    if (draft.kind === 'survey') {
      await input.submitSurvey(draft.surveyId, {
        ...draft.fields,
        submittedBy: draft.fields.contact,
      });
      input.registry.clear(input.sessionId, input.accountId);
      input.postMessage('assistant', `“${draft.surveyTitle}”已实名提交。该问卷不能重复提交或修改。`);
    } else {
      const ticket = await input.submitTicket(ticketInput(draft));
      input.registry.clear(input.sessionId, input.accountId);
      try {
        input.onTicketSubmitted?.(ticket, draft);
      } catch {
        // 会话进展关联是本地辅助能力，失败不能把已成功创建的申请误报为失败并诱发重提。
      }
      input.postMessage('assistant', successMessage(ticket, draft.serviceId));
    }
  } catch (error) {
    input.postMessage('assistant', `园区服务暂未提交成功：${error instanceof Error ? error.message : String(error)}。草稿已保留，可回复“确认提交”重试或回复“取消”。`);
  } finally {
    input.registry.finishSubmission(input.sessionId, input.accountId);
  }
  return true;
}
