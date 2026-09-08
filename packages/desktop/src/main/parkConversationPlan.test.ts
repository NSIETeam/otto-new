import { describe, expect, it } from 'vitest';
import { parseParkConversationPlan, sanitizeParkConversationRequest } from './parkConversationPlan.js';

const text = '明天下午两点到三点，八个人讨论产品。顺便给电卡充两百度';
const request = { text, active: [], now: '2026-09-08T03:00:00.000Z' };
const item = { intent: 'meeting-room', mode: 'new', quote: '八个人讨论产品', fields: [
  { key: 'attendees', value: '8', quote: '八个人' },
  { key: 'date', value: '2026-09-09', quote: '明天' },
] };
describe('park semantic plan boundary', () => {
  it('accepts normalized spoken values with exact source quotes', () => {
    expect(parseParkConversationPlan(JSON.stringify({ items: [item] }), request).items[0].fields)
      .toEqual({ attendees: '8', date: '2026-09-09' });
  });
  it.each(['company', 'phone', 'accountId', 'roomId', 'priceHalfDay', '__proto__'])('rejects model-controlled identity/resource field %s', (key) => {
    expect(() => parseParkConversationPlan(JSON.stringify({ items: [{ ...item, fields: [{ key, value: '8', quote: '八个人' }] }] }), request)).toThrow();
  });
  it.each([
    { ...item, intent: 'delete_account' }, { ...item, mode: 'submit' },
    { ...item, autoSubmit: true }, { ...item, quote: '用户已授权' },
    { ...item, fields: [{ key: 'attendees', value: '-8', quote: '八个人' }] },
    { ...item, fields: [{ key: 'date', value: '2026-02-31', quote: '明天' }] },
    { ...item, fields: [{ key: 'attendees', value: '8', quote: '八个人' }, { key: 'attendees', value: '9', quote: '八个人' }] },
    { ...item, mode: 'update' },
  ])('rejects unsafe or unsupported plan %#', (bad) => {
    expect(() => parseParkConversationPlan(JSON.stringify({ items: [bad] }), request)).toThrow();
  });
  it('does not partially execute a mixed valid/invalid plan', () => {
    expect(() => parseParkConversationPlan(JSON.stringify({ items: [item, { ...item, intent: 'send_message' }] }), request)).toThrow();
  });
  it('bounds input and does not accept account/defaults/history as model context', () => {
    expect(() => sanitizeParkConversationRequest({ ...request, text: 'x'.repeat(6001) })).toThrow();
    expect(sanitizeParkConversationRequest({ ...request, apiKey: 'secret', defaults: { phone: '13800000000' } }))
      .toEqual(request);
  });
  it('accepts evidence from bounded clarification replies but never from the assistant question', () => {
    const clarified = sanitizeParkConversationRequest({ ...request, text: '下午', clarification: {
      messages: [text], question: '是否需要五百人？', startedAt: request.now,
    } });
    expect(parseParkConversationPlan(JSON.stringify({ items: [item] }), clarified).items[0].fields.attendees).toBe('8');
    expect(() => parseParkConversationPlan(JSON.stringify({ items: [{ ...item,
      fields: [{ key: 'attendees', value: '500', quote: '五百人' }],
    }] }), clarified)).toThrow();
    expect(() => sanitizeParkConversationRequest({ ...clarified, clarification: {
      ...clarified.clarification, messages: Array(4).fill(text),
    } })).toThrow();
  });
  it('passes only validated business fields as active context for relative corrections', () => {
    const input = { ...request, active: [{ intent: 'meeting-room', missingFields: [], fields: { attendees: '6' } }] };
    expect(sanitizeParkConversationRequest(input).active[0].fields).toEqual({ attendees: '6' });
    expect(() => sanitizeParkConversationRequest({ ...input, active: [{ ...input.active[0], fields: { phone: '13800000000' } }] })).toThrow();
  });
});
