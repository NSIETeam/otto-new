/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AgentTurnSnapshot } from 'otto-server';
import { AgentTurnTimeline } from './AgentTurnTimeline.js';

describe('AgentTurnTimeline', () => {
  it('renders useful work and confirmation details without exposing internal execution states', () => {
    const turn: AgentTurnSnapshot = {
      contractVersion: 1,
      turnId: 'turn-1',
      sequence: 3,
      status: 'in_progress',
      startedAt: 1,
      updatedAt: 2,
      items: [
        {
          id: 'control-1',
          type: 'control',
          status: 'completed',
          label: '规划并完成变更',
          intent: 'change',
          executionMode: 'planned',
          riskLevel: 'local_write',
          evidenceRequirement: 'local_verification',
        },
        {
          id: 'stage-1',
          type: 'stage',
          status: 'completed',
          label: '理解任务并组织回答',
        },
        {
          id: 'plan-1',
          type: 'plan',
          status: 'in_progress',
          label: '任务计划',
          steps: [
            { id: 'p1', label: '核对上下文', status: 'completed' },
            { id: 'p2', label: '实现并验证', status: 'in_progress' },
          ],
        },
        {
          id: 'tools-1',
          type: 'tool_group',
          status: 'awaiting_confirmation',
          label: '等待确认后继续',
          total: 2,
          completed: 1,
          failed: 0,
          awaitingConfirmation: 1,
        },
        {
          id: 'verification-1',
          type: 'verification',
          status: 'failed',
          label: '部分验证已完成',
          verification: {
            status: 'partial',
            checks: [
              {
                id: 'change',
                label: '请求范围内的变更已经完成',
                status: 'passed',
              },
              {
                id: 'test',
                label: '完成与任务相匹配的验证',
                status: 'not_run',
              },
            ],
          },
        },
      ],
    };
    render(<AgentTurnTimeline turn={turn} />);
    expect(screen.getByRole('list', { name: 'Otto 处理进度' })).toBeTruthy();
    expect(screen.getByText('核对上下文')).toBeTruthy();
    expect(screen.getByText('实现并验证')).toBeTruthy();
    expect(screen.getByText('1 项等待你的确认')).toBeTruthy();
    expect(screen.getByRole('list', { name: '成功条件验证' })).toBeTruthy();
    expect(screen.getByText('已满足')).toBeTruthy();
    expect(screen.getByText('未验证')).toBeTruthy();
    expect(screen.queryByText('规划并完成变更')).toBeNull();
    expect(screen.queryByText('理解任务并组织回答')).toBeNull();
    expect(screen.queryByText('计划执行 · 本地写入')).toBeNull();
    expect(screen.queryByText('进行中')).toBeNull();
    expect(screen.queryByText('等待确认')).toBeNull();
    expect(screen.queryByText('已完成')).toBeNull();
    expect(screen.queryByText('需要处理')).toBeNull();
    expect(screen.queryByText('todo_write')).toBeNull();
  });

  it('renders automatically registered artifacts and citations with verification state', () => {
    const turn: AgentTurnSnapshot = {
      contractVersion: 1,
      turnId: 'turn-with-evidence',
      sequence: 4,
      status: 'completed',
      startedAt: 1,
      updatedAt: 3,
      items: [],
      artifacts: [
        {
          id: 'artifact-1',
          label: '园区报告.pdf',
          path: 'D:\\reports\\园区报告.pdf',
          mimeType: 'application/pdf',
          verified: true,
        },
      ],
      citations: [
        {
          id: 'citation-1',
          label: 'example.com/policy',
          uri: 'https://example.com/policy',
          sourceType: 'web',
          verified: true,
        },
      ],
    };
    render(<AgentTurnTimeline turn={turn} />);
    expect(screen.getByRole('region', { name: '交付物' })).toBeTruthy();
    expect(screen.getByText('园区报告.pdf')).toBeTruthy();
    expect(screen.getByText('已验证')).toBeTruthy();
    expect(screen.getByRole('region', { name: '引用来源' })).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'example.com/policy' })
        .getAttribute('href'),
    ).toBe('https://example.com/policy');
  });
});
