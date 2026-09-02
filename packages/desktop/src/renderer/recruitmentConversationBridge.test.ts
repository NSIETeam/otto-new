/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import {
  RecruitmentConversationDraftRegistry,
  handleRecruitmentConversation,
} from './recruitmentConversationBridge.js';
import { RecruitmentWorkspaceStore } from './recruitmentWorkspaceStore.js';

const resume = `李明
电话：13900139000
邮箱：liming@example.com
2022-2026 星河科技 前端工程师
使用 React 和 TypeScript 开发企业系统
负责性能优化，最终首屏时间降低 30%`;

function harness() {
  const store = new RecruitmentWorkspaceStore();
  const registry = new RecruitmentConversationDraftRegistry();
  const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  const selectFiles = vi.fn()
    .mockResolvedValueOnce(['D:\\resume\\liming.pdf'])
    .mockResolvedValue(['D:\\resume\\interview.mp3']);
  const extractDocument = vi.fn(async () => ({
    filePath: 'D:\\resume\\liming.pdf', fileName: 'liming.pdf', sourceFormat: 'pdf', content: resume,
  }));
  const transcribe = vi.fn(async () => ({
    model: 'large-v3', warning: undefined,
    segments: [
      { speaker: '面试官', startSeconds: 0, text: '请介绍项目' },
      { speaker: '候选人', startSeconds: 5, text: '当时项目很慢，我负责优化，最终首屏降低30%' },
    ],
  }));
  return {
    store, registry, messages, selectFiles, extractDocument, transcribe,
    common: {
      text: '', sessionId: 'session-1', accountId: 'hr-1', enabled: true,
      store, registry, selectFiles, extractDocument, transcribe,
      postMessage: (role: 'user' | 'assistant', text: string) => messages.push({ role, text }),
      now: () => Date.parse('2026-09-02T10:00:00+08:00'),
    },
  };
}

async function importResume(h: ReturnType<typeof harness>): Promise<void> {
  await handleRecruitmentConversation({ ...h.common, text: '帮我分析一份简历' });
  await handleRecruitmentConversation({
    ...h.common,
    text: '岗位名称：高级前端工程师；岗位要求：必须熟练掌握 React 和 TypeScript；保存期限：30天；我确认已取得候选人授权',
  });
  await handleRecruitmentConversation({ ...h.common, text: '确认选择简历' });
}

describe('招聘对话共享桥', () => {
  it('收集岗位、保存期限和明确授权后才允许选择简历', async () => {
    const h = harness();
    expect(await handleRecruitmentConversation({ ...h.common, text: '帮我分析一份简历' })).toBe(true);
    expect(h.messages.at(-1)?.text).toContain('岗位名称');
    expect(h.messages.at(-1)?.text).toContain('岗位要求');
    expect(h.messages.at(-1)?.text).toContain('候选人授权');
    expect(h.selectFiles).not.toHaveBeenCalled();

    await handleRecruitmentConversation({
      ...h.common,
      text: '岗位名称：高级前端工程师；岗位要求：必须熟练掌握 React 和 TypeScript；保存期限：30天；我确认已取得候选人授权',
    });
    expect(h.store.getSnapshot()).toMatchObject({
      jobTitle: '高级前端工程师', consentConfirmed: true, retentionDays: 30,
    });
    expect(h.messages.at(-1)?.text).toContain('确认选择简历');
    expect(h.selectFiles).not.toHaveBeenCalled();
  });

  it('导入后右侧工作区与对话共享候选人，输出不泄露手机号邮箱', async () => {
    const h = harness();
    await importResume(h);
    expect(h.selectFiles).toHaveBeenCalledTimes(1);
    expect(h.store.getSnapshot().candidates).toHaveLength(1);
    expect(h.store.activeCandidate()?.analysis.findings.length).toBeGreaterThan(0);
    const output = h.messages.at(-1)?.text ?? '';
    expect(output).toContain('简历分析完成');
    expect(output).not.toContain('13900139000');
    expect(output).not.toContain('liming@example.com');
  });

  it('人员初步分析只展示证据状态，不自动给出淘汰决定', async () => {
    const h = harness();
    await importResume(h);
    await handleRecruitmentConversation({ ...h.common, text: '查看候选人人员初步分析' });
    const output = h.messages.at(-1)?.text ?? '';
    expect(output).toContain('原文证据');
    expect(output).toContain('最终招聘决定必须由招聘人员作出');
    expect(output).not.toContain('自动淘汰');
  });

  it('面试材料可直接从共享候选人生成', async () => {
    const h = harness();
    await importResume(h);
    await handleRecruitmentConversation({ ...h.common, text: '生成这个候选人的面试材料' });
    expect(h.messages.at(-1)?.text).toContain('结构化面试问题');
    expect(h.messages.at(-1)?.text).toContain('评价规则');
  });

  it('音频分析需确认选择文件，并只分析回答内容', async () => {
    const h = harness();
    await importResume(h);
    await handleRecruitmentConversation({ ...h.common, text: '分析这个候选人的面试录音' });
    expect(h.messages.at(-1)?.text).toContain('确认选择面试录音');
    expect(h.transcribe).not.toHaveBeenCalled();
    await handleRecruitmentConversation({ ...h.common, text: '确认选择面试录音' });
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect(h.store.activeCandidate()?.transcriptReport).toBeTruthy();
    expect(h.messages.at(-1)?.text).toContain('不分析口音、音高、表情或情绪');
  });

  it('隐私审计可查询，删除当前候选人材料需要强确认', async () => {
    const h = harness();
    await importResume(h);
    await handleRecruitmentConversation({ ...h.common, text: '查看招聘隐私与审计' });
    expect(h.messages.at(-1)?.text).toContain('保存期限 30 天');
    await handleRecruitmentConversation({ ...h.common, text: '删除当前候选人材料' });
    expect(h.store.getSnapshot().candidates).toHaveLength(1);
    expect(h.messages.at(-1)?.text).toContain('确认删除候选人材料');
    await handleRecruitmentConversation({ ...h.common, text: '确认删除候选人材料' });
    expect(h.store.getSnapshot().candidates).toHaveLength(0);
    expect(h.store.getSnapshot().audits[0]?.action).toBe('candidate_purged');
  });

  it('功能介绍、普通聊天和无候选人的误触不会启动外部文件选择', async () => {
    const h = harness();
    for (const text of ['介绍一下简历分析功能', '今天天气如何']) {
      expect(await handleRecruitmentConversation({ ...h.common, text })).toBe(false);
    }
    expect(h.selectFiles).not.toHaveBeenCalled();
  });
});
