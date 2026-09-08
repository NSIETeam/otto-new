/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { PARK_INTENTS, isParkIntent, parkIntentFields, validateParkFields, type ParkConversationIntent, type ParkConversationItem,
  sanitizeParkConversationRequest, type ParkClarificationContext, type ParkConversationPlan, type ParkConversationRequest } from '../main/parkConversationPlan.js';

const TTL = 30 * 60 * 1000;
interface PendingClarification extends ParkClarificationContext { activeKey: string; retry?: boolean }
interface Queue { scope: string; sessionId: string; expiresAt: number; items: ParkConversationItem[]; clarification?: PendingClarification }
export interface ActiveParkDraft { id: string; intent: ParkConversationIntent; updatedAt: number; missingFields?: string[]; fields?: Record<string, string> }
export interface ParkConversationTurn {
  scope: string; sessionId: string; text: string; targetDraftId?: string;
  active(): ActiveParkDraft[];
  isCurrent(): boolean;
  plan(input: ParkConversationRequest): Promise<ParkConversationPlan>;
  /** An item only prepares/updates. Only raw, locally recognized commands may submit/cancel. */
  execute(item: ParkConversationItem | null, command: string, draft?: ActiveParkDraft): Promise<boolean>;
  postMessage(role: 'user' | 'assistant', text: string): void;
  now?: () => number;
}

function directPlan(text: string): ParkConversationPlan | null {
  for (const [intent, name] of Object.entries(PARK_INTENTS)) {
    const phrases = intent.startsWith('query:') ? [name, `查看${name}`] : [name, `我要${name}`];
    if (phrases.includes(text)) {
      return { items: [{ intent: intent as ParkConversationIntent, mode: 'new', quote: text, fields: {} }] };
    }
  }
  return null;
}
export function isParkConversationCandidate(text: string): boolean {
  return /(?:园区(?:统计|待办|合作|办事)|物业|报修|灯|空调|断网|漏水|停车|车位|电卡|访客|来访|装修|会议室|固话|专线|满意度|问卷|公告|我的申请)/u.test(text);
}
export function parseParkConversationCommand(text: string): '确认提交' | '取消' | null {
  if (/^(?:确认提交|确认|提交|提交吧|可以提交|信息无误)[。！!\s]*$/u.test(text)) return '确认提交';
  if (/^(?:取消|取消报修|取消申请|不办了|不提交了|放弃|不用了)[。！!\s]*$/u.test(text)) return '取消';
  return null;
}
function explicitFieldPlan(text: string, active: ActiveParkDraft[]): ParkConversationPlan | null {
  if (active.length !== 1) return null;
  const intent = active[0].intent;
  const schema = parkIntentFields(intent);
  const values: Record<string, string> = {};
  for (const part of text.split(/[；;\n]/u).map((part) => part.trim()).filter(Boolean)) {
    const match = part.match(/^([^：:]{1,30})[：:]\s*(.+)$/u);
    const field = match && schema.find((field) => field.key === match[1].trim() || field.label === match[1].trim());
    if (!field || !match || Object.hasOwn(values, field.key)) return null;
    values[field.key] = match[2].trim();
  }
  if (!Object.keys(values).length) return null;
  try {
    return { items: [{ intent, mode: 'update', quote: text, fields: validateParkFields(intent, values) }] };
  } catch { return null; }
}

export class ParkConversationCoordinator {
  private readonly queues = new Map<string, Queue>();
  private readonly running = new Set<string>();
  private key(scope: string, sessionId: string): string { return JSON.stringify([scope, sessionId]); }
  private queue(scope: string, sessionId: string, now: number): Queue {
    const key = this.key(scope, sessionId);
    const current = this.queues.get(key);
    if (current && current.expiresAt > now) return current;
    this.queues.delete(key);
    return { scope, sessionId, expiresAt: now + TTL, items: [] };
  }
  snapshot(scope: string, now = Date.now()): Queue[] {
    for (const [key, queue] of this.queues) if (queue.expiresAt <= now || (!queue.items.length && !queue.clarification)) this.queues.delete(key);
    return structuredClone([...this.queues.values()].filter((queue) => queue.scope === scope));
  }
  restore(scope: string, payload: unknown, now = Date.now()): void {
    if (!Array.isArray(payload)) return;
    for (const raw of payload.slice(0, 20)) {
      try {
        if (!raw || raw.scope !== scope || typeof raw.sessionId !== 'string' || !raw.sessionId || raw.sessionId.length > 500
          || !Number.isFinite(raw.expiresAt) || raw.expiresAt <= now || raw.expiresAt > now + TTL
          || !Array.isArray(raw.items) || raw.items.length > 4 || JSON.stringify(raw).length > 100_000) continue;
        const items: ParkConversationItem[] = raw.items.map((item: ParkConversationItem) => {
          if (!item || !isParkIntent(item.intent) || item.mode !== 'new' || typeof item.quote !== 'string' || item.quote.length > 6000) throw new Error('invalid');
          return { intent: item.intent, mode: 'new', quote: item.quote, fields: validateParkFields(item.intent, item.fields) };
        });
        let clarification: PendingClarification | undefined;
        if (raw.clarification) {
          const pending = raw.clarification;
          const context = sanitizeParkConversationRequest({ text: '恢复', active: [], now: new Date(now).toISOString(), clarification: pending }).clarification!;
          if (typeof pending.activeKey !== 'string' || pending.activeKey.length > 20000
            || context.messages.length < 1
            || (pending.retry !== undefined && typeof pending.retry !== 'boolean')
            || Date.parse(context.startedAt) > now || Date.parse(context.startedAt) + TTL <= now) throw new Error('invalid clarification');
          clarification = { ...context, activeKey: pending.activeKey, retry: pending.retry === true };
        }
        this.queues.set(this.key(scope, raw.sessionId), { scope, sessionId: raw.sessionId, expiresAt: raw.expiresAt, items, clarification });
      } catch { /* Damaged/old queues never become executable commands. */ }
    }
  }
  private describe(input: ParkConversationTurn, queue: Queue): void {
    const current = input.active();
    const lines = current.map((draft) => `当前：${PARK_INTENTS[draft.intent]}（${draft.missingFields?.length ? '待补充' : '请检查摘要后确认'}）`);
    if (queue.items.length) lines.push(`待办：${queue.items.map((item, i) => `${i + 1}. ${PARK_INTENTS[item.intent]}`).join(' → ')}`);
    if (queue.clarification) lines.push(queue.clarification.retry ? '有一条理解失败的需求，可说“继续办理”重试。' : `待澄清：${queue.clarification.question}`);
    input.postMessage('assistant', lines.length ? `${lines.join('\n')}\n每次确认只提交当前一项；可说“查看办事清单”“取消后续事项”“取消后续第2项”“取消追问”或“继续办理”。` : '当前没有园区办事草稿或后续待办。');
  }
  private async advance(input: ParkConversationTurn, queue: Queue): Promise<void> {
    if (input.active().length || !queue.items.length || !input.isCurrent()) return;
    const next = queue.items[0];
    // Do not dequeue until preparation succeeds; defaults/resources failures can resume without another model call.
    const prepared = await input.execute(next, '');
    if (!input.isCurrent()) return;
    if (prepared) queue.items.shift();
    else input.postMessage('assistant', '该事项暂未准备成功，已保留待办。恢复连接后回复“继续办理”重试，不会自动提交。');
  }

  async handle(input: ParkConversationTurn): Promise<boolean> {
    const text = input.text.trim();
    const now = input.now?.() ?? Date.now();
    const key = this.key(input.scope, input.sessionId);
    // Work on a copy: discarding a late turn must not mutate or erase earlier pending work.
    const queue = structuredClone(this.queue(input.scope, input.sessionId, now));
    const active = input.active();
    const command = parseParkConversationCommand(text);
    const cancelIndex = text.match(/^取消后续第([1-9]\d?|[一二三四])项[。！!]?$/u);
    const management = /^(?:查看办事清单|继续办理|取消后续事项|取消追问)$/u.test(text) || !!cancelIndex;
    if (!input.targetDraftId && /(?:政策|招聘|简历|拼车)/u.test(text) && !isParkConversationCandidate(text)) return false;
    if (!input.targetDraftId && !management && !active.length && !queue.items.length && !queue.clarification
      && !isParkConversationCandidate(text)) return false;
    if (this.running.has(key)) {
      input.postMessage('assistant', '上一条办事请求仍在处理，请等结果后继续；本条没有重复执行。'); return true;
    }
    if (!input.isCurrent()) return true;
    this.snapshot(input.scope, now);
    if (!this.queues.has(key) && this.queues.size >= 20) {
      input.postMessage('assistant', '已保留二十个会话的办事上下文，请先完成或取消旧会话待办；没有覆盖已有记录。'); return true;
    }
    this.running.add(key);
    let posted = false;
    const postUser = (): void => { if (!posted) { input.postMessage('user', text); posted = true; } };
    try {
      if (input.targetDraftId && !active.some((draft) => draft.id === input.targetDraftId)) {
        postUser(); input.postMessage('assistant', '该草稿已变化或过期，请查看当前草稿再确认。本次未提交。'); return true;
      }
      if (/^(?:全部|都|一起).{0,4}(?:确认|提交)/u.test(text)) {
        postUser(); input.postMessage('assistant', '多项事务需要逐项检查、确认；本次没有批量提交。'); this.describe(input, queue); return true;
      }
      if (queue.clarification && !input.targetDraftId && (command || text === '取消追问')) {
        postUser();
        if (command === '取消' || text === '取消追问') {
          delete queue.clarification;
          input.postMessage('assistant', '已取消这次追问及尚未理解完成的需求，已有草稿和后续待办未改变。');
        } else input.postMessage('assistant', `请先回答追问或说“取消追问”。这次确认没有提交任何草稿。\n${queue.clarification.question}`);
        return true;
      }
      const retry = text === '继续办理' && queue.clarification?.retry === true;
      if (management && !retry) {
        postUser();
        if (text === '取消后续事项') queue.items = [];
        if (cancelIndex) {
          const index = (/^\d/u.test(cancelIndex[1]) ? Number(cancelIndex[1]) : '一二三四'.indexOf(cancelIndex[1]) + 1) - 1;
          const item = queue.items[index];
          if (item) { queue.items.splice(index, 1); input.postMessage('assistant', `已取消后续第${index + 1}项：${PARK_INTENTS[item.intent]}。未取消当前草稿或已提交工单。`); }
          else input.postMessage('assistant', '该后续序号不存在，待办未改变。请按最新清单选择。');
        }
        if (text === '继续办理' && !queue.clarification) await this.advance(input, queue);
        this.describe(input, queue); return true;
      }
      if (command) {
        postUser();
        const targets = input.targetDraftId ? active.filter((draft) => draft.id === input.targetDraftId) : active;
        if (targets.length !== 1) {
          input.postMessage('assistant', targets.length ? '有多个草稿，请在草稿卡片上选择需要确认或取消的那一项。' : '当前没有可确认的园区草稿。后续待办请回复“继续办理”，不会把本次确认用于下一项。');
          return true;
        }
        await input.execute(null, command, targets[0]);
        if (input.isCurrent()) { await this.advance(input, queue); if (queue.items.length) this.describe(input, queue); }
        return true;
      }
      const before = JSON.stringify(active);
      const pending = queue.clarification;
      if (pending && pending.activeKey !== before) {
        delete queue.clarification; postUser();
        input.postMessage('assistant', '追问期间草稿已变化，旧追问已停止。请基于当前草稿重新完整描述需求，本次未修改或提交。'); return true;
      }
      const effectiveText = retry ? pending!.messages.at(-1)! : text;
      const previousMessages = retry ? pending!.messages.slice(0, -1) : pending?.messages ?? [];
      const messages = [...previousMessages, effectiveText];
      if (messages.length > 3 || messages.join('').length > 5990) {
        postUser(); input.postMessage('assistant', '本次追问上下文已达到上限。请说“取消追问”，再一次完整描述需求；已有草稿未改变。'); return true;
      }
      const request: ParkConversationRequest = { text: effectiveText, now: new Date(now).toISOString(),
        active: active.map((draft) => ({ intent: draft.intent, missingFields: draft.missingFields ?? [], ...(draft.fields ? { fields: draft.fields } : {}) })),
        ...(previousMessages.length || retry ? { clarification: { messages: previousMessages, question: pending?.question ?? '', startedAt: pending!.startedAt } } : {}),
      };
      const localPlan = pending ? null : explicitFieldPlan(text, active) ?? directPlan(text);
      let plan: ParkConversationPlan;
      try { plan = localPlan ?? await input.plan(request); }
      catch {
        queue.clarification = { messages, question: pending?.question ?? '', startedAt: pending?.startedAt ?? request.now, activeKey: before, retry: true };
        throw new Error('understanding failed');
      }
      if (!input.isCurrent()) return true;
      if (JSON.stringify(input.active()) !== before) {
        postUser(); input.postMessage('assistant', '理解期间草稿已变化，请基于最新草稿重说一次。本次未修改或提交。'); return true;
      }
      if (plan.clarification) {
        queue.clarification = { messages, question: plan.clarification, startedAt: pending?.startedAt ?? request.now, activeKey: before };
        postUser(); input.postMessage('assistant', `还需要确认：${plan.clarification}\n可直接补充回答，或说“取消追问”。本轮尚未创建或提交事项。`); return true;
      }
      if (!plan.items.length) return false;
      postUser();
      const queued = plan.items.filter((item) => item.mode === 'new' && !item.intent.startsWith('query:'));
      if (queued.length + queue.items.length > 4) {
        input.postMessage('assistant', '后续事项最多保留四项，请先完成或取消已有待办。本轮没有修改草稿。'); return true;
      }
      delete queue.clarification;
      if (plan.items.length > 1) input.postMessage('assistant', `本轮识别：${plan.items.map((item) => PARK_INTENTS[item.intent]).join('、')}。申请将逐项准备并确认。`);
      for (const item of plan.items) {
        if (!input.isCurrent()) return true;
        if (item.mode === 'update') {
          const target = input.active().filter((draft) => draft.intent === item.intent);
          if (target.length !== 1) throw new Error('补充信息没有唯一草稿');
          await input.execute(item, '', target[0]);
        } else if (item.intent.startsWith('query:')) await input.execute(item, '');
        else {
          queue.items.push(structuredClone(item));
        }
      }
      await this.advance(input, queue);
      if (queue.items.length) this.describe(input, queue);
      return true;
    } catch {
      if (input.isCurrent()) {
        postUser(); input.postMessage('assistant', '这次办事理解或准备未完成，已有草稿和后续待办已保留。没有自动重试。可说“查看办事清单”或“继续办理”；也可通过右侧模块办理。');
      }
      return true;
    } finally {
      if (input.isCurrent()) {
        if (queue.items.length || queue.clarification) this.queues.set(key, queue);
        else this.queues.delete(key);
      }
      this.running.delete(key);
    }
  }
}
