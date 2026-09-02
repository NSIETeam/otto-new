/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { ConversationActionDraftSummary } from './conversationActionDraft.js';

export const CUSTOMER_MODULE_DRAFT_TTL_MS = 30 * 60 * 1_000;
const MAX_DRAFTS = 5_000;
const MAX_SCHEMA_FIELDS = 50;
const MAX_INPUT_TEXT = 4_000;
const MAX_OUTPUT_TEXT = 20_000;
const UNSAFE_SCHEMA_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

interface CustomerModuleProperty {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  enum?: unknown;
  minimum?: unknown;
  maximum?: unknown;
}

export interface ConversationalCustomerModule {
  id: string;
  version: string;
  name: string;
  description: string;
  enabled: boolean;
  suspendedReason?: string;
  riskStatus?: 'suspended' | 'withdrawn';
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  permissions: Array<Record<string, unknown>>;
}

interface CustomerModuleRunResult {
  result: {
    status: 'completed' | 'timed_out' | 'crashed' | 'cancelled';
    exitCode: number | null;
    output: string;
    error?: string;
  };
  audit: Array<Record<string, unknown>>;
  hostAudit: Array<Record<string, unknown>>;
}

export interface CustomerModuleConversationDraft {
  id: string;
  moduleId: string;
  version: string;
  moduleName: string;
  sessionId: string;
  accountId: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  phase: 'collecting' | 'awaiting_confirmation' | 'run_failed';
  inputSchema: ConversationalCustomerModule['inputSchema'];
  permissions: Array<Record<string, unknown>>;
  values: Record<string, unknown>;
}

export interface CustomerModuleConversationInput {
  text: string;
  sessionId: string;
  accountId: string;
  enabled: boolean;
  registry: CustomerModuleConversationDraftRegistry;
  modules: readonly ConversationalCustomerModule[];
  runModule(input: {
    runId: string;
    moduleId: string;
    version: string;
    formInput: Record<string, unknown>;
  }): Promise<CustomerModuleRunResult>;
  postMessage(role: 'user' | 'assistant', text: string): void;
  /** UI 草稿中心确认时必须绑定当前展示的草稿，拒绝串单或过期确认。 */
  expectedDraftId?: string;
  now?: () => number;
}

function textValue(value: unknown, limit = MAX_INPUT_TEXT): string {
  return typeof value === 'string'
    ? Array.from(value.trim()).slice(0, limit).join('')
    : '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function labeledValue(text: string, labels: readonly string[]): string {
  const pattern = labels.map(escapeRegExp).join('|');
  const match = text.match(new RegExp(`(?:${pattern})[：:\\s]+([^，,。；;\\n]+)`, 'u'));
  return textValue(match?.[1]);
}

function propertyRecord(raw: unknown): CustomerModuleProperty {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as CustomerModuleProperty
    : {};
}

function safeSchemaKey(key: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key) && !UNSAFE_SCHEMA_KEYS.has(key);
}

function schemaEntries(module: ConversationalCustomerModule): Array<[string, unknown]> {
  return Object.entries(module.inputSchema.properties)
    .filter(([key]) => safeSchemaKey(key))
    .slice(0, MAX_SCHEMA_FIELDS);
}

function propertyLabel(key: string, property: CustomerModuleProperty): string {
  return textValue(property.title, 100) || key;
}

function supportedType(property: CustomerModuleProperty): 'string' | 'number' | 'integer' | 'boolean' | null {
  return ['string', 'number', 'integer', 'boolean'].includes(String(property.type))
    ? property.type as 'string' | 'number' | 'integer' | 'boolean'
    : null;
}

function paidModel(permissions: ReadonlyArray<Record<string, unknown>>): boolean {
  return permissions.some((permission) => permission.kind === 'model' && permission.paid === true);
}

function detectModule(
  text: string,
  modules: readonly ConversationalCustomerModule[],
): ConversationalCustomerModule | null {
  if (/(?:介绍|解释|是什么|怎么用|如何使用|功能)/u.test(text)) return null;
  if (!/(?:运行|使用|调用|执行|启动|打开)/u.test(text)) return null;
  return [...modules]
    .filter((module) => (
      module.enabled
      && !module.suspendedReason
      && !module.riskStatus
      && text.includes(module.name.trim())
    ))
    .sort((left, right) => right.name.length - left.name.length)[0] ?? null;
}

function unsupportedRequiredFields(module: ConversationalCustomerModule): string[] {
  const entries = Object.entries(module.inputSchema.properties);
  if (entries.length > MAX_SCHEMA_FIELDS) return ['字段数量超过对话桥上限'];
  return [...new Set(module.inputSchema.required ?? [])].flatMap((key) => {
    const raw = Object.prototype.hasOwnProperty.call(module.inputSchema.properties, key)
      ? module.inputSchema.properties[key]
      : undefined;
    if (!safeSchemaKey(key)) return [textValue(propertyRecord(raw).title, 100) || '不安全字段名'];
    if (raw === undefined) return [key];
    const property = propertyRecord(raw);
    return supportedType(property) ? [] : [propertyLabel(key, property)];
  });
}

function parseBoolean(value: string): boolean | undefined {
  if (/^(?:是|需要|包含|开启|启用|true|yes|1)$/iu.test(value.trim())) return true;
  if (/^(?:否|不需要|不包含|关闭|禁用|false|no|0)$/iu.test(value.trim())) return false;
  return undefined;
}

function parseValue(text: string, key: string, property: CustomerModuleProperty): unknown {
  const label = propertyLabel(key, property);
  const raw = labeledValue(text, [label, key]);
  if (!raw) return undefined;
  const type = supportedType(property);
  if (type === 'boolean') return parseBoolean(raw);
  if (type === 'number' || type === 'integer') {
    const number = Number(raw);
    if (!Number.isFinite(number) || (type === 'integer' && !Number.isInteger(number))) return undefined;
    if (typeof property.minimum === 'number' && number < property.minimum) return undefined;
    if (typeof property.maximum === 'number' && number > property.maximum) return undefined;
    return number;
  }
  if (type === 'string') {
    const enumValues = Array.isArray(property.enum)
      ? property.enum.filter((item): item is string => typeof item === 'string')
      : [];
    if (enumValues.length > 0) {
      return enumValues.find((item) => raw === item || raw.includes(item));
    }
    return raw;
  }
  return undefined;
}

function applyText(
  draft: CustomerModuleConversationDraft,
  text: string,
  allowUnlabeledSingle = false,
): CustomerModuleConversationDraft {
  const values = { ...draft.values };
  let parsedCount = 0;
  for (const [key, raw] of Object.entries(draft.inputSchema.properties).filter(([candidate]) => safeSchemaKey(candidate)).slice(0, MAX_SCHEMA_FIELDS)) {
    const parsed = parseValue(text, key, propertyRecord(raw));
    if (parsed === undefined) continue;
    values[key] = parsed;
    parsedCount += 1;
  }
  const missing = missingRequired({ ...draft, values });
  if (allowUnlabeledSingle && parsedCount === 0 && missing.length === 1 && !isConfirmation(text) && !isCancellation(text)) {
    const key = missing[0]!.key;
    const property = propertyRecord(draft.inputSchema.properties[key]);
    const type = supportedType(property);
    const raw = textValue(text);
    if (type === 'string' && raw) values[key] = raw;
    else if (type === 'number' || type === 'integer') {
      const number = Number(raw);
      if (Number.isFinite(number) && (type !== 'integer' || Number.isInteger(number))) values[key] = number;
    } else if (type === 'boolean') {
      const boolean = parseBoolean(raw);
      if (boolean !== undefined) values[key] = boolean;
    }
  }
  const next = { ...draft, values };
  next.phase = missingRequired(next).length === 0 ? 'awaiting_confirmation' : 'collecting';
  return next;
}

function missingRequired(draft: CustomerModuleConversationDraft): Array<{ key: string; label: string }> {
  return (draft.inputSchema.required ?? []).flatMap((key) => {
    const property = propertyRecord(draft.inputSchema.properties[key]);
    const value = draft.values[key];
    const missing = value === undefined || value === null || (typeof value === 'string' && !value.trim());
    return missing ? [{ key, label: propertyLabel(key, property) }] : [];
  });
}

function createDraft(
  module: ConversationalCustomerModule,
  input: CustomerModuleConversationInput,
  now: number,
): CustomerModuleConversationDraft {
  const draft: CustomerModuleConversationDraft = {
    id: `customer-module:${module.id}:${input.accountId}:${input.sessionId}:${now}`,
    moduleId: module.id,
    version: module.version,
    moduleName: textValue(module.name, 200),
    sessionId: input.sessionId,
    accountId: input.accountId,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + CUSTOMER_MODULE_DRAFT_TTL_MS,
    phase: 'collecting',
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(schemaEntries(module)),
      required: [...new Set(module.inputSchema.required ?? [])]
        .filter((key) => safeSchemaKey(key))
        .slice(0, MAX_SCHEMA_FIELDS),
    },
    permissions: module.permissions.map((permission) => ({ ...permission })),
    values: {},
  };
  return applyText(draft, input.text, false);
}

function collectionMessage(draft: CustomerModuleConversationDraft): string {
  const missing = missingRequired(draft).map((item) => item.label);
  return `“${draft.moduleName}”运行草稿已建立。请补充必填项：${missing.join('、')}。可以按“字段名：内容”一次填写多项。`;
}

function valueLabel(value: unknown): string {
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return String(value);
  return textValue(value);
}

function confirmationMessage(draft: CustomerModuleConversationDraft): string {
  const values = Object.entries(draft.values).map(([key, value]) => {
    const label = propertyLabel(key, propertyRecord(draft.inputSchema.properties[key]));
    return `- ${label}：${valueLabel(value)}`;
  });
  const paid = paidModel(draft.permissions);
  const permissionKinds = [...new Set(draft.permissions.map((permission) => textValue(permission.kind, 80)).filter(Boolean))];
  return [
    `“${draft.moduleName}”输入已完整：`, '', ...values,
    ...(permissionKinds.length ? ['', `权限范围：${permissionKinds.join('、')}`] : []),
    ...(paid ? ['该模块可能产生模型 Token 费用。'] : []),
    '', paid
      ? '回复“确认运行并同意费用”后执行；回复“取消”可放弃。'
      : '回复“确认运行”后执行；回复“取消”可放弃。',
  ].join('\n');
}

function isConfirmation(text: string): boolean {
  return /^(?:确认运行(?:并同意费用)?|确认执行|确认)[。！!\s]*$/u.test(text.trim());
}

function confirmsPaidRun(text: string): boolean {
  return /^(?:确认运行并同意费用|重新运行并同意费用)[。！!\s]*$/u.test(text.trim());
}

function isRetry(text: string): boolean {
  return /^(?:重新运行(?:并同意费用)?|重试运行)[。！!\s]*$/u.test(text.trim());
}

function isCancellation(text: string): boolean {
  return /^(?:取消|取消运行|不运行了|不用了|放弃)[。！!\s]*$/u.test(text.trim());
}

function auditMessage(events: ReadonlyArray<Record<string, unknown>>): string {
  const modelEvents = events.filter((event) => event.capability === 'model');
  if (modelEvents.length === 0) return '';
  const tokens = modelEvents.reduce((total, event) => (
    total + Number(event.inputTokens ?? 0) + Number(event.outputTokens ?? 0)
  ), 0);
  const providers = [...new Set(modelEvents.map((event) => textValue(event.provider, 80)).filter(Boolean))];
  return `\n\n调用审计：${providers.length ? `${providers.join('、')} · ` : ''}Token ${tokens}。`;
}

export class CustomerModuleConversationDraftRegistry {
  private readonly drafts = new Map<string, CustomerModuleConversationDraft>();
  private readonly running = new Set<string>();

  private key(sessionId: string, accountId: string): string {
    return `${accountId}:${sessionId}`;
  }

  get(sessionId: string, accountId: string, now: number = Date.now()): CustomerModuleConversationDraft | null {
    const key = this.key(sessionId, accountId);
    const draft = this.drafts.get(key);
    if (!draft) return null;
    if (draft.sessionId !== sessionId || draft.accountId !== accountId || draft.expiresAt <= now) {
      this.drafts.delete(key);
      this.running.delete(key);
      return null;
    }
    return draft;
  }

  save(draft: CustomerModuleConversationDraft): void {
    const key = this.key(draft.sessionId, draft.accountId);
    this.drafts.delete(key);
    this.drafts.set(key, draft);
    while (this.drafts.size > MAX_DRAFTS) {
      const oldest = this.drafts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.drafts.delete(oldest);
      this.running.delete(oldest);
    }
  }

  clear(sessionId: string, accountId: string): void {
    const key = this.key(sessionId, accountId);
    this.drafts.delete(key);
    this.running.delete(key);
  }

  summary(
    sessionId: string,
    accountId: string,
    now: number = Date.now(),
  ): ConversationActionDraftSummary | null {
    const draft = this.get(sessionId, accountId, now);
    if (!draft) return null;
    const missing = missingRequired(draft).map((item) => item.label);
    const paid = paidModel(draft.permissions);
    const failed = draft.phase === 'run_failed';
    const running = this.running.has(this.key(sessionId, accountId));
    return {
      id: draft.id,
      source: 'customer-module',
      title: draft.moduleName,
      phase: running ? 'submitting' : draft.phase === 'run_failed' ? 'failed' : draft.phase,
      updatedAt: draft.updatedAt,
      expiresAt: draft.expiresAt,
      missingFields: missing,
      incursCost: paid,
      ...(!running && missing.length === 0 ? {
        confirmationText: failed
          ? paid ? '重新运行并同意费用' : '重新运行'
          : paid ? '确认运行并同意费用' : '确认运行',
      } : {}),
    };
  }

  discard(id: string, sessionId: string, accountId: string, now: number = Date.now()): boolean {
    const draft = this.get(sessionId, accountId, now);
    if (!draft || draft.id !== id) return false;
    if (this.running.has(this.key(sessionId, accountId))) return false;
    this.clear(sessionId, accountId);
    return true;
  }

  beginRun(sessionId: string, accountId: string): boolean {
    const key = this.key(sessionId, accountId);
    if (this.running.has(key)) return false;
    this.running.add(key);
    return true;
  }

  finishRun(sessionId: string, accountId: string): void {
    this.running.delete(this.key(sessionId, accountId));
  }

  snapshot(accountId: string, now: number = Date.now()): CustomerModuleConversationDraft[] {
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
      const draft = raw as Partial<CustomerModuleConversationDraft>;
      if (
        typeof draft.id !== 'string'
        || typeof draft.moduleId !== 'string'
        || typeof draft.version !== 'string'
        || typeof draft.moduleName !== 'string'
        || typeof draft.sessionId !== 'string'
        || draft.sessionId.length > 500
        || draft.accountId !== accountId
        || typeof draft.createdAt !== 'number'
        || typeof draft.updatedAt !== 'number'
        || typeof draft.expiresAt !== 'number'
        || draft.expiresAt <= now
        || !['collecting', 'awaiting_confirmation', 'run_failed'].includes(String(draft.phase))
        || !draft.inputSchema
        || draft.inputSchema.type !== 'object'
        || !draft.inputSchema.properties
        || typeof draft.inputSchema.properties !== 'object'
        || Array.isArray(draft.inputSchema.properties)
        || !Array.isArray(draft.permissions)
        || !draft.values
        || typeof draft.values !== 'object'
        || Array.isArray(draft.values)
      ) continue;
      this.save(draft as CustomerModuleConversationDraft);
      restored += 1;
    }
    return restored;
  }
}

export async function handleCustomerModuleConversation(
  input: CustomerModuleConversationInput,
): Promise<boolean> {
  if (!input.enabled || !input.text.trim()) return false;
  const now = input.now?.() ?? Date.now();
  let draft = input.registry.get(input.sessionId, input.accountId, now);
  if (input.expectedDraftId && draft?.id !== input.expectedDraftId) {
    input.postMessage('assistant', '该模块运行草稿已变化或过期，本次没有运行。请检查当前草稿后重新确认。');
    return true;
  }
  const module = draft ? null : detectModule(input.text, input.modules);
  if (!draft && !module) return false;
  input.postMessage('user', input.text.trim());

  if (draft && isCancellation(input.text)) {
    input.registry.clear(input.sessionId, input.accountId);
    input.postMessage('assistant', `已取消“${draft.moduleName}”运行草稿，模块不会运行。`);
    return true;
  }
  const retryingFailedRun = draft?.phase === 'run_failed';

  if (!draft && module) {
    const unsupported = unsupportedRequiredFields(module);
    if (unsupported.length > 0) {
      input.postMessage('assistant', `“${module.name}”包含对话桥暂不支持的必填字段（${unsupported.join('、')}），请从右侧模块界面运行，以使用完整控件和权限提示。`);
      return true;
    }
    draft = createDraft(module, input, now);
  } else if (draft) {
    if (retryingFailedRun && !isRetry(input.text)) {
      input.postMessage('assistant', `“${draft.moduleName}”上次运行状态未确认。若确定要再次执行，请回复“${paidModel(draft.permissions) ? '重新运行并同意费用' : '重新运行'}”；回复“取消”可清除草稿。`);
      return true;
    }
    draft = {
      ...applyText(draft, input.text, true),
      updatedAt: now,
      expiresAt: now + CUSTOMER_MODULE_DRAFT_TTL_MS,
    };
  }
  if (!draft) return false;
  input.registry.save(draft);
  const missing = missingRequired(draft);
  if (missing.length > 0) {
    input.postMessage('assistant', collectionMessage(draft));
    return true;
  }
  const paid = paidModel(draft.permissions);
  const confirmed = retryingFailedRun ? isRetry(input.text) : isConfirmation(input.text);
  if (!confirmed) {
    input.postMessage('assistant', confirmationMessage(draft));
    return true;
  }
  if (paid && !confirmsPaidRun(input.text)) {
    input.postMessage('assistant', '该模块可能产生模型 Token 费用。请明确回复“确认运行并同意费用”；若是失败后重试，请回复“重新运行并同意费用”。');
    return true;
  }
  if (!input.registry.beginRun(input.sessionId, input.accountId)) {
    input.postMessage('assistant', `“${draft.moduleName}”正在运行，请勿重复操作。`);
    return true;
  }
  try {
    const execution = await input.runModule({
      runId: `module:${crypto.randomUUID()}`,
      moduleId: draft.moduleId,
      version: draft.version,
      formInput: { ...draft.values },
    });
    if (execution.result.status !== 'completed') {
      throw new Error(execution.result.error || execution.result.status);
    }
    input.registry.clear(input.sessionId, input.accountId);
    const output = textValue(execution.result.output, MAX_OUTPUT_TEXT) || '模块已完成，但没有返回文本结果。';
    input.postMessage('assistant', `“${draft.moduleName}”运行完成：\n\n${output}${auditMessage(execution.hostAudit)}`);
  } catch (error) {
    const failed: CustomerModuleConversationDraft = {
      ...draft,
      phase: 'run_failed',
      updatedAt: now,
      expiresAt: now + CUSTOMER_MODULE_DRAFT_TTL_MS,
    };
    input.registry.save(failed);
    input.postMessage('assistant', `“${draft.moduleName}”未能确认运行成功：${error instanceof Error ? error.message : String(error)}。为避免重复产生外部操作或费用，Otto 不会自动重试；确认后可回复“${paid ? '重新运行并同意费用' : '重新运行'}”。`);
  } finally {
    input.registry.finishRun(input.sessionId, input.accountId);
  }
  return true;
}
