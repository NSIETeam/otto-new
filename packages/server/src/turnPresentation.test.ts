/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import {
  deriveTurnControlPolicy,
  formatTurnControlDirective,
} from './turnControlPolicy.js';

describe('natural response policy', () => {
  it.each([
    '你好',
    '修复登录并运行测试',
    '创建 PPT',
    '查找最新政策',
    '提交园区工单',
  ])('does not prescribe report headings for %s', (text) => {
    const policy = deriveTurnControlPolicy({
      text,
      source: 'local',
      toolFree: false,
    });
    expect(policy.presentation.finalSections).toEqual(['result']);
    expect(formatTurnControlDirective(policy)).not.toContain('final_sections=');
    expect(formatTurnControlDirective(policy)).toContain(
      'Do not impose fixed headings',
    );
  });
  it('honors brevity without weakening research evidence or confirmation', () => {
    const brief = deriveTurnControlPolicy({
      text: '简短比较最新政策',
      source: 'local',
      toolFree: false,
    });
    expect(brief.presentation.detailLevel).toBe('compact');
    expect(brief.requiresVerification).toBe(true);
    expect(brief.evidenceRequirement).toBe('primary_sources');
    const deploy = deriveTurnControlPolicy({
      text: '部署服务器，只要结论',
      source: 'local',
      toolFree: false,
    });
    expect(deploy.confirmationMode).toBe('always');
  });
  it('does not inject file/test/research instructions into ordinary answers', () => {
    const simple = deriveTurnControlPolicy({
      text: '1 + 1 是多少？',
      source: 'local',
      toolFree: false,
    });
    const directive = formatTurnControlDirective(simple);
    expect(directive).not.toContain('separate foreground');
    expect(directive).not.toContain('verify the real non-empty file');
    expect(directive).toContain('Do not add a planning or review round');
    expect(simple.requiresVerification).toBe(false);
  });
});
