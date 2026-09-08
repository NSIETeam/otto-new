import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { InstalledSkillReleases } from 'otto-server';
import { SkillVersionPanel } from './SkillVersionPanel.js';

const current: InstalledSkillReleases['current'] = {
  id: 'b'.repeat(64),
  capturedAt: '2026-09-03T00:00:00Z',
  function: {
    title: '销售月报助手',
    summary: '销售明细整理成月报',
    inputs: ['销售明细'],
    outputs: ['月报'],
    scope: ['本地表格'],
    boundaries: ['不发送客户资料'],
  },
  files: { 'SKILL.md': 'new', 'scripts/new.cjs': 'script' },
  staticValidation: { passed: true, errors: [], warnings: [] },
  acceptance: [],
};
const skills: InstalledSkillReleases[] = [
  {
    skillName: 'report-helper',
    current,
    history: [{ ...current, id: 'a'.repeat(64), files: { 'SKILL.md': 'old' } }],
    warnings: [],
  },
];
const props = () => ({
  skills,
  busy: false,
  error: null,
  onRefresh: vi.fn(),
  onRollback: vi.fn(),
  onRecord: vi.fn(),
});
describe('Skill 版本与证据界面', () => {
  it('没有案例时不暗示业务可靠，展示功能及使用边界', () => {
    render(<SkillVersionPanel {...props()} />);
    expect(screen.getByText('销售明细整理成月报')).toBeTruthy();
    expect(screen.getByText(/尚未验证业务效果/)).toBeTruthy();
    expect(screen.getByText('不发送客户资料')).toBeTruthy();
    expect(screen.queryByText(/成功率.*100/)).toBeNull();
  });
  it('先选择旧版并看删除文件，再显式勾选确认回滚', () => {
    const p = props();
    render(<SkillVersionPanel {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /选择此版本回滚/ }));
    expect(p.onRollback).not.toHaveBeenCalled();
    expect(screen.getByText(/移除：scripts\/new.cjs/)).toBeTruthy();
    const confirm = screen.getByRole('button', {
      name: '确认回滚',
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /我已了解/ }));
    fireEvent.click(confirm);
    expect(p.onRollback).toHaveBeenCalledWith({
      skillName: 'report-helper',
      versionId: 'a'.repeat(64),
      expectedCurrentHash: current.id,
      confirmed: true,
    });
  });
  it('版本变化时关闭旧的回滚确认，不能确认旧预览', () => {
    const p = props();
    const view = render(<SkillVersionPanel {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /选择此版本回滚/ }));
    view.rerender(
      <SkillVersionPanel
        {...p}
        skills={[{ ...skills[0], current: { ...current, id: 'c'.repeat(64) } }]}
      />,
    );
    expect(screen.queryByRole('button', { name: '确认回滚' })).toBeNull();
  });
  it('人工复核需填写输入、标准、实际结果和环境并确认，才能保存', () => {
    const p = props();
    render(<SkillVersionPanel {...p} />);
    fireEvent.click(screen.getByRole('button', { name: '记录实际试用' }));
    for (const [label, value] of [
      ['试用场景', '缺少金额'],
      ['测试输入', '金额空白'],
      ['验收标准', '询问金额'],
      ['实际结果', '询问金额'],
      ['模型与运行环境', 'Windows / model-A'],
    ]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.change(screen.getByLabelText('复核结论'), {
      target: { value: 'passed' },
    });
    expect(
      (
        screen.getByRole('button', {
          name: '保存复核证据',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /亲自复核/ }));
    fireEvent.click(screen.getByRole('button', { name: '保存复核证据' }));
    expect(p.onRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        skillName: 'report-helper',
        expectedCurrentHash: current.id,
        actual: '询问金额',
        verdict: 'passed',
        confirmed: true,
      }),
    );
  });
});
