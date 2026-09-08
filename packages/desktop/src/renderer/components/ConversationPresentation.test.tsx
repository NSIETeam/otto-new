/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it, vi } from 'vitest';
import type { OttoMessage } from 'otto-server';
import { presentConversationMessages } from './ChatView.js';
vi.mock('../assets/otto-avatar.png', () => ({ default: 'avatar.png' }));
const msg = (
  id: string,
  text: string,
  extra: Partial<OttoMessage> = {},
): OttoMessage => ({
  id,
  sessionId: 's',
  role: 'assistant',
  source: 'local',
  timestamp: 1,
  turnId: 't',
  content: [{ type: 'text', value: text }],
  ...extra,
});
describe('lossless conversation presentation', () => {
  it('preserves legacy findings and nested progress, discarding only exact acknowledgments', () => {
    const output = presentConversationMessages([
      msg('a', '我先查一下。'),
      msg('b', '实际原因是旧连接仍在重试。'),
      msg('c', '已修复。', {
        phase: 'final_answer',
        progressMessages: [{ id: 'p', text: '原文件已备份。', timestamp: 0 }],
      }),
    ]);
    expect(output).toHaveLength(1);
    expect(output[0].progressMessages?.map((p) => p.text)).toEqual([
      '实际原因是旧连接仍在重试。',
      '原文件已备份。',
    ]);
    expect(presentConversationMessages(output)).toEqual(output);
  });
  it('keeps the latest snapshot rather than the obsolete root snapshot', () => {
    const old = {
      contractVersion: 1 as const,
      turnId: 't',
      sequence: 1,
      status: 'in_progress' as const,
      startedAt: 0,
      updatedAt: 0,
      items: [],
    };
    const latest = {
      ...old,
      sequence: 9,
      status: 'incomplete' as const,
      updatedAt: 9,
    };
    const output = presentConversationMessages([
      msg('a', '找到一处异常', {
        turn: old,
        isProcessingTools: true,
        isReasoning: true,
        toolsCompleted: false,
      }),
      msg('b', '仍需核对结果', { turn: latest, phase: 'final_answer' }),
    ]);
    expect(output[0].turn).toEqual(latest);
    expect(output[0].isProcessingTools).toBe(false);
    expect(output[0].isReasoning).toBe(false);
    expect(output[0].toolsCompleted).toBe(true);
  });
  it('does not let a late empty tool item replace the final, or discard trailing useful prose', () => {
    const output = presentConversationMessages([
      msg('f', '已经保存报告', { phase: 'final_answer' }),
      msg('p', '注意：报告未包含第三季度数据', { phase: 'commentary' }),
      msg('empty', ''),
    ]);
    expect(output[0].id).toBe('f');
    expect(output[0].progressMessages?.map((p) => p.text)).toContain(
      '注意：报告未包含第三季度数据',
    );
  });
  it('deduplicates exact paragraphs but never guesses two findings are semantically identical', () => {
    const output = presentConversationMessages([
      msg('a', '登录支持重试。', { phase: 'commentary' }),
      msg('b', '支付不支持重试。', { phase: 'commentary' }),
      msg('c', '登录支持重试。\n\n支付仍待验证。', { phase: 'final_answer' }),
    ]);
    expect(output[0].progressMessages?.map((p) => p.text)).toEqual([
      '支付不支持重试。',
    ]);
  });
  it('does not merge different turns or across user steering', () => {
    const messages = [
      msg('a', '先修改'),
      msg('u', '不要修改', { role: 'user' }),
      msg('b', '已停止'),
      msg('c', '另一个回答', { turnId: 'other' }),
    ];
    expect(presentConversationMessages(messages)).toHaveLength(4);
  });
});
