import { describe, expect, it, vi } from 'vitest';
import { ParkConversationCoordinator } from './parkConversationCoordinator.js';
import type { ParkConversationItem } from '../main/parkConversationPlan.js';

function harness() {
  const coordinator = new ParkConversationCoordinator();
  let active: Array<{ id: string; intent: 'repair' | 'electric-card'; updatedAt: number }> = [];
  const messages: string[] = [];
  const execute = vi.fn(async (item: ParkConversationItem | null, command: string) => {
    if (command === '确认提交' || command === '取消') active = [];
    else if (item && !item.intent.startsWith('query:')) active = [{ id: item.intent, intent: item.intent as 'repair', updatedAt: 1 }];
    return true;
  });
  const plan = vi.fn();
  const common = { scope: 'org:a', sessionId: 's', active: () => active, execute, plan,
    postMessage: (_role: string, message: string) => { messages.push(message); }, isCurrent: () => true, now: () => 100 };
  const turn = (text: string) => coordinator.handle({ ...common, text });
  return { coordinator, common, turn, plan, execute, messages, setActive: (value: typeof active) => { active = value; } };
}
const repair: ParkConversationItem = { intent: 'repair', mode: 'new', quote: '灯闪', fields: { issue: '灯闪' } };
const card: ParkConversationItem = { intent: 'electric-card', mode: 'new', quote: '充电', fields: { chargingKwh: '200' } };
describe('park conversation orchestration', () => {
  it('uses no model for explicit schema fields and does not treat viewing a form as submitting one', async () => {
    const h = harness(); h.setActive([{ id: 'r', intent: 'repair', updatedAt: 1 }]);
    await h.turn('紧急程度：普通；故障描述：顶灯闪烁');
    expect(h.plan).not.toHaveBeenCalled();
    expect(h.execute.mock.calls[0][0]?.fields).toEqual({ urgency: '普通', issue: '顶灯闪烁' });
    h.setActive([]); h.plan.mockResolvedValue({ items: [] });
    expect(await h.turn('查看物业报修')).toBe(false);
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
  it('keeps a task whose preparation failed and resumes it without parsing again', async () => {
    const h = harness(); h.plan.mockResolvedValue({ items: [card] });
    h.execute.mockResolvedValueOnce(false);
    await h.turn('电卡充电');
    expect(h.coordinator.snapshot('org:a', 100)[0].items).toHaveLength(1);
    await h.turn('继续办理');
    expect(h.plan).toHaveBeenCalledTimes(1);
    expect(h.execute).toHaveBeenCalledTimes(2);
    expect(h.coordinator.snapshot('org:a', 100)).toEqual([]);
  });
  it('rejects a late plan when the draft was edited during understanding', async () => {
    const h = harness(); h.setActive([{ id: 'r', intent: 'repair', updatedAt: 1 }]);
    h.plan.mockImplementationOnce(async () => {
      h.setActive([{ id: 'r', intent: 'repair', updatedAt: 2 }]);
      return { items: [{ ...repair, mode: 'update' }] };
    });
    await h.turn('灯闪请改成普通');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.messages.join('')).toContain('草稿已变化');
  });
  it('does not process a partial plan when clarification is needed', async () => {
    const h = harness(); h.plan.mockResolvedValue({ items: [repair], clarification: '另一项是停车还是访客？' });
    await h.turn('灯闪，再帮我处理那个车的事情');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.coordinator.snapshot('org:a', 100)[0].items).toEqual([]);
    expect(h.coordinator.snapshot('org:a', 100)[0].clarification?.messages).toEqual(['灯闪，再帮我处理那个车的事情']);
  });
  it('restores a clarification and binds a short reply to the original request without submitting', async () => {
    const h = harness(); h.plan.mockResolvedValueOnce({ items: [], clarification: '上午还是下午？' });
    await h.turn('明天两点到三点预约会议室');
    const restored = new ParkConversationCoordinator(); restored.restore('org:a', h.coordinator.snapshot('org:a', 100), 100);
    h.plan.mockResolvedValueOnce({ items: [{ intent: 'meeting-room', mode: 'new', quote: '预约会议室', fields: { startTime: '14:00' } }] });
    await restored.handle({ ...h.common, text: '下午' });
    expect(h.plan.mock.calls[1][0].clarification.messages).toEqual(['明天两点到三点预约会议室']);
    expect(h.execute.mock.calls[0][1]).toBe('');
    expect(restored.snapshot('org:a', 100)).toEqual([]);
  });
  it('does not treat confirmation or cancellation of a clarification as permission for an unrelated draft', async () => {
    const h = harness(); h.setActive([{ id: 'r', intent: 'repair', updatedAt: 1 }]);
    h.plan.mockResolvedValueOnce({ items: [], clarification: '上午还是下午？' });
    await h.turn('再订个会议室，两点'); await h.turn('确认提交');
    expect(h.execute).not.toHaveBeenCalled();
    await h.turn('取消');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.common.active()).toHaveLength(1);
    expect(h.coordinator.snapshot('org:a', 100)).toEqual([]);
  });
  it('expires clarification context and rejects changed draft bindings', async () => {
    const h = harness(); h.setActive([{ id: 'r', intent: 'repair', updatedAt: 1 }]);
    h.plan.mockResolvedValue({ items: [], clarification: '是普通还是紧急？' }); await h.turn('灯闪要快点');
    const saved = h.coordinator.snapshot('org:a', 100);
    h.setActive([{ id: 'r', intent: 'repair', updatedAt: 2 }]); await h.turn('普通');
    expect(h.plan).toHaveBeenCalledTimes(1); expect(h.execute).not.toHaveBeenCalled();
    const next = new ParkConversationCoordinator(); next.restore('org:a', saved, 31 * 60 * 1000);
    expect(next.snapshot('org:a', 31 * 60 * 1000)).toEqual([]);
  });
  it('retains a failed semantic request for explicit retry without losing its wording', async () => {
    const h = harness(); h.plan.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ items: [repair] });
    await h.turn('灯闪要报修'); await h.turn('继续办理');
    expect(h.plan.mock.calls[1][0].text).toBe('灯闪要报修');
    expect(h.execute).toHaveBeenCalledTimes(1); expect(h.execute.mock.calls[0][1]).toBe('');
  });
  it('cancels only the numbered queued item and rejects out-of-range indices without model use', async () => {
    const h = harness(); h.plan.mockResolvedValueOnce({ items: [repair, card, { ...repair, quote: '另一个灯' }] });
    await h.turn('报修两处并充电卡'); await h.turn('取消后续第2项');
    expect(h.coordinator.snapshot('org:a', 100)[0].items).toEqual([card]);
    await h.turn('取消后续第4项');
    expect(h.coordinator.snapshot('org:a', 100)[0].items).toEqual([card]);
    expect(h.plan).toHaveBeenCalledTimes(1); expect(h.execute).toHaveBeenCalledTimes(1);
  });
  it('collapses 200 concurrent turns into one understanding/preparation operation', async () => {
    const h = harness(); let release!: () => void;
    h.plan.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ items: [repair] }); }));
    const attempts = Array.from({ length: 200 }, () => h.turn('灯闪')); await Promise.resolve();
    expect(h.plan).toHaveBeenCalledTimes(1); release(); await Promise.all(attempts);
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
  it('leaves policy, recruiting and carpool requests to their original modules', async () => {
    const h = harness(); h.setActive([{ id: 'r', intent: 'repair', updatedAt: 1 }]);
    for (const text of ['查询企业可申报政策', '我要招聘一名前端', '帮我分析简历', '我要拼车']) expect(await h.turn(text)).toBe(false);
    expect(h.plan).not.toHaveBeenCalled(); expect(h.execute).not.toHaveBeenCalled();
  });
  it('prepares one item, queues the next, and never forwards confirmation to the next item', async () => {
    const h = harness(); h.plan.mockResolvedValue({ items: [repair, card] });
    await h.turn('灯闪，还要充电');
    expect(h.execute).toHaveBeenCalledTimes(1);
    await h.turn('确认提交');
    expect(h.execute.mock.calls[1][1]).toBe('确认提交');
    expect(h.execute.mock.calls[2][0]?.intent).toBe('electric-card');
    expect(h.execute.mock.calls[2][1]).toBe('');
  });
  it('routes read queries without modifying an existing repair draft', async () => {
    const h = harness(); h.setActive([{ id: 'r', intent: 'repair', updatedAt: 1 }]);
    h.plan.mockResolvedValue({ items: [{ intent: 'query:announcements', mode: 'new', quote: '公告', fields: {} }] });
    await h.turn('顺便看看公告');
    expect(h.execute.mock.calls[0][0]?.intent).toBe('query:announcements');
  });
  it('rejects an ambiguous confirmation when two older drafts exist', async () => {
    const h = harness(); h.setActive([{ id: 'r', intent: 'repair', updatedAt: 1 }, { id: 'e', intent: 'electric-card', updatedAt: 1 }]);
    await h.turn('确认提交');
    expect(h.execute).not.toHaveBeenCalled(); expect(h.messages.join('')).toContain('草稿');
  });
  it('keeps remaining tasks on submission failure and restores only within scope and TTL', async () => {
    const h = harness(); h.plan.mockResolvedValue({ items: [repair, card] });
    await h.turn('灯闪，还要充电');
    h.execute.mockImplementationOnce(async () => { throw new Error('timeout'); });
    await h.turn('确认提交');
    expect(h.coordinator.snapshot('org:a', 100)).toHaveLength(1);
    const next = new ParkConversationCoordinator();
    next.restore('org:b', h.coordinator.snapshot('org:a', 100), 100);
    expect(next.snapshot('org:b', 100)).toEqual([]);
    next.restore('org:a', h.coordinator.snapshot('org:a', 100), 100);
    expect(next.snapshot('org:a', 100)).toHaveLength(1);
    expect(next.snapshot('org:a', 31 * 60 * 1000)).toEqual([]);
  });
  it('does not fall back into a draft on semantic failure or unrelated chat', async () => {
    const h = harness(); h.setActive([{ id: 'r', intent: 'repair', updatedAt: 1 }]);
    h.plan.mockRejectedValueOnce(new Error('offline'));
    expect(await h.turn('明天再弄吧，先安排另外一件事')).toBe(true);
    expect(h.execute).not.toHaveBeenCalled();
    h.plan.mockResolvedValue({ items: [] });
    expect(await h.turn('帮我写一首诗')).toBe(false);
    expect(h.execute).not.toHaveBeenCalled();
  });
  it('drops late plans after account change and never uses all-confirm as a command', async () => {
    const h = harness(); h.plan.mockResolvedValue({ items: [repair] });
    await h.coordinator.handle({ ...h.common, text: '灯闪', isCurrent: () => false });
    expect(h.execute).not.toHaveBeenCalled();
    await h.turn('全部确认提交');
    expect(h.execute).not.toHaveBeenCalled();
  });
  it('does not delete existing pending tasks when a late reply is discarded after switching sessions', async () => {
    const h = harness(); h.plan.mockResolvedValueOnce({ items: [repair, card] });
    await h.turn('灯闪，还要充电');
    let current = true;
    h.plan.mockImplementationOnce(async () => { current = false; return { items: [repair] }; });
    await h.coordinator.handle({ ...h.common, text: '再报修另一处灯', isCurrent: () => current });
    expect(h.coordinator.snapshot('org:a', 100)[0]?.items).toEqual([card]);
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
});
