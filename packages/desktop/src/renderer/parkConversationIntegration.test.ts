import { describe, expect, it, vi } from 'vitest';
import { handleModuleActionConversation, ModuleActionDraftRegistry } from './moduleActionBridge.js';
import { handleParkServiceActionConversation, ParkServiceActionDraftRegistry } from './parkServiceActionBridge.js';
import { ParkConversationCoordinator, type ActiveParkDraft } from './parkConversationCoordinator.js';
import { handleParkQueryConversation } from './parkModuleConversationBridge.js';
import { parseParkConversationPlan } from '../main/parkConversationPlan.js';
const defaults = { company: '企业', roomNumber: 'A1203', contact: '张三', phone: '13800000000' };
const repairFields = { issue: '顶灯闪烁', category: '灯具维修', urgency: '普通' };
describe('semantic plan to real drafts', () => {
  it('uses distinct draft IDs for two requests prepared in the same millisecond', async () => {
    const registry = new ModuleActionDraftRegistry();
    const input = { text: '我要报修', sessionId: 's', accountId: 'a', enabled: true, registry,
      loadDefaults: async () => defaults, submit: vi.fn(), postMessage: vi.fn(), now: () => 123 };
    await handleModuleActionConversation(input); const first = registry.get('s', 'a', 123)!.id;
    registry.clear('s', 'a'); await handleModuleActionConversation(input);
    expect(registry.get('s', 'a', 123)!.id).not.toBe(first);
  });
  it('runs parsed repair + card plans with an interleaved query, two separate confirmations and encrypted-save-before-write hooks', async () => {
    const repair = new ModuleActionDraftRegistry(); const park = new ParkServiceActionDraftRegistry();
    const coordinator = new ParkConversationCoordinator();
    const text = '顶灯闪烁，不着急；再给电卡充两百度';
    const plan = parseParkConversationPlan(JSON.stringify({ items: [
      { intent: 'repair', mode: 'new', quote: '顶灯闪烁，不着急', fields: [
        { key: 'category', value: '灯具维修', quote: '顶灯' }, { key: 'issue', value: '顶灯闪烁', quote: '顶灯闪烁' },
        { key: 'urgency', value: '普通', quote: '不着急' },
      ] },
      { intent: 'electric-card', mode: 'new', quote: '给电卡充两百度', fields: [{ key: 'chargingKwh', value: '200', quote: '两百度' }] },
    ] }), { text, active: [], now: new Date().toISOString() });
    const requests: unknown[] = []; const messages: string[] = []; const events: string[] = [];
    const submit = vi.fn(async (input: unknown) => { requests.push(input); events.push('send'); return { id: `ticket-${requests.length}`, status: 'pending', recipients: [], recipientCount: 0 }; });
    const postMessage = (_role: string, message: string): void => { messages.push(message); };
    const beforeSubmit = async (): Promise<void> => {
      expect([...repair.snapshot('a'), ...park.snapshot('a')].some((draft) => draft.submissionAttempted)).toBe(true);
      events.push('save');
    };
    const active = (): ActiveParkDraft[] => [
      ...(repair.get('s', 'a') ? [{ id: repair.get('s', 'a')!.id, intent: 'repair' as const, updatedAt: repair.get('s', 'a')!.updatedAt }] : []),
      ...(park.get('s', 'a') ? [{ id: park.get('s', 'a')!.id, intent: 'electric-card' as const, updatedAt: park.get('s', 'a')!.updatedAt }] : []),
    ];
    const turn: Parameters<typeof coordinator.handle>[0] = {
      scope: 'org:a', sessionId: 's', text, active, isCurrent: () => true, postMessage,
      plan: vi.fn(async () => plan),
      execute: async (item, command, draft) => {
        const intent = item?.intent ?? draft?.intent;
        const common = { text: item?.quote ?? command, sessionId: 's', accountId: 'a', enabled: true,
          loadDefaults: async () => defaults, postMessage, beforeSubmit, expectedDraftId: draft?.id };
        if (intent === 'repair') {
          await handleModuleActionConversation({ ...common, registry: repair, submit,
            semantic: item ? { intent: 'repair', fields: item.fields } : undefined });
          return !item || !!repair.get('s', 'a');
        }
        if (intent === 'electric-card') {
          await handleParkServiceActionConversation({ ...common, registry: park, submitTicket: submit,
            loadMeetingResources: vi.fn(), listPublications: vi.fn(), submitSurvey: vi.fn(),
            semantic: item ? { intent: 'electric-card', fields: item.fields } : undefined });
          return !item || !!park.get('s', 'a');
        }
        return handleParkQueryConversation({ text: '查看园区公告', enabled: true, postMessage,
          listPublications: async () => [], loadStatistics: vi.fn(), loadStarMap: vi.fn(), listMyApplications: vi.fn(), listStaffTasks: vi.fn() });
      },
    };
    await coordinator.handle(turn);
    expect(submit).not.toHaveBeenCalled(); expect(repair.get('s', 'a')?.fields.urgency).toBe('普通');
    await coordinator.handle({ ...turn, text: '查看园区公告' });
    expect(repair.get('s', 'a')?.fields.issue).toBe('顶灯闪烁');
    await coordinator.handle({ ...turn, text: '确认提交' });
    expect(submit).toHaveBeenCalledTimes(1); expect(park.get('s', 'a')?.fields.chargingKwh).toBe('200');
    await coordinator.handle({ ...turn, text: '确认提交' });
    expect(submit).toHaveBeenCalledTimes(2); expect(events).toEqual(['save', 'send', 'save', 'send']);
    expect(active()).toEqual([]); expect(coordinator.snapshot('org:a')).toEqual([]);
    expect(messages.join('')).toContain('申请信息已完整');
    expect(messages.join('')).not.toContain('1 位物业维修人员');
  });
  it('does not send when secure persistence fails, and restores the frozen request', async () => {
    const registry = new ModuleActionDraftRegistry(); const submit = vi.fn();
    const input = { text: '我要报修', sessionId: 's', accountId: 'a', enabled: true, registry,
      loadDefaults: async () => defaults, submit, postMessage: vi.fn() };
    await handleModuleActionConversation({ ...input, semantic: { intent: 'repair', fields: repairFields } });
    await handleModuleActionConversation({ ...input, text: '确认提交', beforeSubmit: async () => { throw new Error('vault failed'); } });
    expect(submit).not.toHaveBeenCalled();
    const restored = new ModuleActionDraftRegistry(); restored.restore('a', registry.snapshot('a'));
    expect(restored.get('s', 'a')?.submissionAttempted).toBe(true);
    expect(restored.summary('s', 'a')?.phase).toBe('failed');
  });
  it('does not save a late prepared draft after switching accounts', async () => {
    const registry = new ModuleActionDraftRegistry(); let current = true;
    await handleModuleActionConversation({ text: '灯闪', sessionId: 's', accountId: 'a', enabled: true,
      registry, loadDefaults: async () => { current = false; return defaults; }, submit: vi.fn(), postMessage: vi.fn(),
      isCurrent: () => current, semantic: { intent: 'repair', fields: repairFields } });
    expect(registry.get('s', 'a')).toBeNull();
  });
  it('only prepares a repair even when the raw utterance asks for direct submission', async () => {
    const registry = new ModuleActionDraftRegistry(); const submit = vi.fn();
    await handleModuleActionConversation({ text: '灯一直闪，直接提交', sessionId: 's', accountId: 'a', enabled: true,
      registry, loadDefaults: async () => defaults, submit, postMessage: vi.fn(),
      semantic: { intent: 'repair', fields: repairFields } });
    expect(submit).not.toHaveBeenCalled();
    expect(registry.get('s', 'a')?.fields).toMatchObject(repairFields);
    expect(registry.get('s', 'a')?.autoSubmit).toBe(false);
  });
  it('preserves a possibly submitted repair payload across edits and retries', async () => {
    const registry = new ModuleActionDraftRegistry(); const submit = vi.fn(async () => { throw new Error('lost reply'); });
    const input = { text: '我要报修', sessionId: 's', accountId: 'a', enabled: true, registry,
      loadDefaults: async () => defaults, submit, postMessage: vi.fn() };
    await handleModuleActionConversation({ ...input, semantic: { intent: 'repair', fields: repairFields } });
    await handleModuleActionConversation({ ...input, text: '确认提交' });
    await handleModuleActionConversation({ ...input, text: '改成空调', semantic: { intent: 'repair', fields: { issue: '空调不制冷' } } });
    await handleModuleActionConversation({ ...input, text: '确认提交' });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]).toEqual(submit.mock.calls[0]);
  });
  it('applies typed spoken quantities using the common form schema', async () => {
    const registry = new ParkServiceActionDraftRegistry(); const submitTicket = vi.fn();
    await handleParkServiceActionConversation({ text: '电费再充两百度', sessionId: 's', accountId: 'a', enabled: true,
      registry, loadDefaults: async () => defaults, loadMeetingResources: vi.fn(), listPublications: vi.fn(),
      submitTicket, submitSurvey: vi.fn(), postMessage: vi.fn(), semantic: { intent: 'electric-card', fields: { chargingKwh: '200' } } });
    expect(submitTicket).not.toHaveBeenCalled();
    expect(registry.get('s', 'a')?.fields.chargingKwh).toBe('200');
  });
  it('does not turn a model-chosen cancellation quote into a cancellation command', async () => {
    const registry = new ParkServiceActionDraftRegistry();
    const input = { text: '电卡服务', sessionId: 's', accountId: 'a', enabled: true, registry,
      loadDefaults: async () => defaults, loadMeetingResources: vi.fn(), listPublications: vi.fn(),
      submitTicket: vi.fn(), submitSurvey: vi.fn(), postMessage: vi.fn() };
    await handleParkServiceActionConversation({ ...input, semantic: { intent: 'electric-card', fields: { chargingKwh: '200' } } });
    await handleParkServiceActionConversation({ ...input, text: '取消', semantic: { intent: 'electric-card', fields: { chargingKwh: '100' } } });
    expect(registry.get('s', 'a')?.fields.chargingKwh).toBe('100');
    expect(input.submitTicket).not.toHaveBeenCalled();
  });
  it('catches the last meeting resource recheck failure and retains the draft', async () => {
    const registry = new ParkServiceActionDraftRegistry();
    const now = Date.now();
    registry.save({ kind: 'ticket', id: 'm', sessionId: 's', accountId: 'a', serviceId: 'meeting-room', idempotencyKey: 'key',
      createdAt: now, updatedAt: now, expiresAt: now + 100000, phase: 'awaiting_confirmation', fields: {
        ...defaults, attendees: '2', meetingContent: '产品讨论', date: '2099-01-01', startTime: '14:00', endTime: '14:30', roomId: 'r', roomName: '1号', roomCapacity: '5', priceHalfDay: '100', time: '14:00-14:30',
      } });
    const loadMeetingResources = vi.fn().mockRejectedValueOnce(new Error('offline'));
    const submitTicket = vi.fn(); const postMessage = vi.fn();
    await expect(handleParkServiceActionConversation({ text: '确认提交', sessionId: 's', accountId: 'a', enabled: true,
      registry, loadDefaults: async () => defaults, loadMeetingResources, listPublications: vi.fn(), submitTicket,
      submitSurvey: vi.fn(), postMessage })).resolves.toBe(true);
    expect(submitTicket).not.toHaveBeenCalled(); expect(registry.get('s', 'a')).not.toBeNull();
    expect(postMessage.mock.calls.at(-1)?.[1]).toContain('保留');
  });
  it('requires fresh confirmation when meeting prices changed after the summary', async () => {
    const registry = new ParkServiceActionDraftRegistry(); const submitTicket = vi.fn(async () => ({ id: 'ticket', status: 'pending', recipients: [], recipientCount: 0 }));
    let price = 100;
    const input = { text: '预约会议室', sessionId: 's', accountId: 'a', enabled: true, registry,
      loadDefaults: async () => defaults, listPublications: vi.fn(), submitTicket, submitSurvey: vi.fn(), postMessage: vi.fn(),
      loadMeetingResources: vi.fn(async () => ({ settings: { parkingTotal: 10, parkingNote: null, updatedAt: '' },
        meetingRooms: [{ id: 'r', name: '1号', location: 'A座', equipment: [], capacity: 5, enabled: true, priceHalfDay: price }],
        meetingSlots: [{ id: 'slot', label: '14:00', roomId: 'r', date: '2099-01-01', slotKey: '14:00', status: 'available' as const }] })),
    };
    await handleParkServiceActionConversation({ ...input, semantic: { intent: 'meeting-room', fields: {
      attendees: '2', meetingContent: '产品讨论', date: '2099-01-01', startTime: '14:00', endTime: '14:30',
    } } });
    price = 200; await handleParkServiceActionConversation({ ...input, text: '确认提交' });
    expect(submitTicket).not.toHaveBeenCalled();
    expect(registry.get('s', 'a')?.fields.priceHalfDay).toBe('200');
    expect(input.postMessage.mock.calls.at(-1)?.[1]).toContain('重新确认');
    await handleParkServiceActionConversation({ ...input, text: '确认提交' });
    expect(submitTicket).toHaveBeenCalledTimes(1);
  });
});
