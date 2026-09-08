import { describe, expect, it } from 'vitest';
import { validateClientPayload } from './protocol.js';

describe('Skill 版本协议', () => {
  const rollback = {
    skillName: 'sales-report',
    versionId: 'a'.repeat(64),
    expectedCurrentHash: 'b'.repeat(64),
    confirmed: true,
  };
  it('回滚必须显式确认并绑定预览版本', () => {
    expect(
      validateClientPayload({
        type: 'rollback_skill_release',
        payload: rollback,
      }),
    ).toBeNull();
    for (const patch of [
      { confirmed: false },
      { confirmed: undefined },
      { skillName: '../outside' },
      { versionId: '../x' },
      { expectedCurrentHash: '' },
    ]) {
      expect(
        validateClientPayload({
          type: 'rollback_skill_release',
          payload: { ...rollback, ...patch },
        }),
      ).not.toBeNull();
    }
  });
  it('复核记录需实际输出、环境及用户确认，不接受只有一个模型分数', () => {
    const trial = {
      skillName: 'sales-report',
      expectedCurrentHash: rollback.expectedCurrentHash,
      scenario: '月报',
      input: '数据',
      expected: '带合计',
      actual: '合计一致',
      environment: 'Windows/model-A',
      verdict: 'passed',
      confirmed: true,
    };
    expect(
      validateClientPayload({
        type: 'record_skill_acceptance',
        payload: trial,
      }),
    ).toBeNull();
    for (const patch of [
      { actual: '' },
      { environment: '' },
      { confirmed: false },
      { scenario: 'a'.repeat(201) },
      { verdict: '95%' },
    ]) {
      expect(
        validateClientPayload({
          type: 'record_skill_acceptance',
          payload: { ...trial, ...patch },
        }),
      ).not.toBeNull();
    }
    expect(
      validateClientPayload({ type: 'get_skill_releases', payload: {} }),
    ).toBeNull();
  });
});
