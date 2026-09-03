/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import type { OttoMessage } from 'otto-server';
import { presentConversationMessages } from './ChatView.js';

function message(
  id: string,
  text: string,
  phase?: OttoMessage['phase'],
): OttoMessage {
  return {
    id,
    sessionId: 's',
    role: 'assistant',
    source: 'local',
    timestamp: 1,
    content: [{ type: 'text', value: text }],
    phase,
    turnId: 't',
  };
}

describe('phase-aware conversation presentation', () => {
  it('retains meaningful commentary separately from the final answer, including without the root snapshot', () => {
    const [answer] = presentConversationMessages([
      message('a', '发现版本冲突，需要保留旧接口。', 'commentary'),
      message('b', '已保留兼容接口并通过验证。', 'final_answer'),
    ]);
    expect(answer.id).toBe('b');
    expect(answer.content[0]).toEqual({
      type: 'text',
      value: '已保留兼容接口并通过验证。',
    });
    expect(answer.progressMessages?.map((item) => item.text)).toEqual([
      '发现版本冲突，需要保留旧接口。',
    ]);
  });
  it('does not mistake a late tool-only message for final delivery', () => {
    const [answer] = presentConversationMessages([
      message('a', '交付文件已经生成。', 'final_answer'),
      message('b', '', 'commentary'),
    ]);
    expect(answer.id).toBe('a');
  });
  it('does not merge different turns or sessions', () => {
    expect(
      presentConversationMessages([
        message('a', 'first', 'commentary'),
        { ...message('b', 'second', 'final_answer'), turnId: 't2' },
        { ...message('c', 'third', 'final_answer'), sessionId: 's2' },
      ]),
    ).toHaveLength(3);
  });
  it('preserves multiple commentary items and removes exact duplicates only', () => {
    const [answer] = presentConversationMessages([
      message('a', '发现缺失依赖。', 'commentary'),
      message('b', '发现缺失依赖。', 'commentary'),
      message('c', '安装需要授权，当前未执行。', 'commentary'),
      message('d', '等待授权。', 'final_answer'),
    ]);
    expect(answer.progressMessages).toHaveLength(2);
  });
});
