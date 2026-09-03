/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import {
  captureCompressionInvariants,
  appendCompressionInvariantSnapshot,
  validateCompressionInvariants,
} from './compressionInvariants.js';
import { stripUIFields, type Content } from '../types/extendedContent.js';
const user = (text: string): Content => ({ role: 'user', parts: [{ text }] });

describe('typed compaction continuity', () => {
  it('retains explicit replacement chronology without reviving the previous goal', () => {
    const snapshot = captureCompressionInvariants(
      [
        user('创建市场分析报告'),
        user('取消之前的任务，改为修复登录流程。'),
        user('继续'),
      ],
      0,
    );
    expect(snapshot.goals.join(' ')).not.toContain('市场分析报告');
    expect(snapshot.continuity?.requests.at(-1)?.supersedes.length).toBe(1);
    expect(snapshot.continuity?.requests.at(-1)?.text).toContain('修复登录');
  });
  it('does not promote a generated summary or tool text to a new user request on repeated compaction', () => {
    const first = captureCompressionInvariants(
      [user('修复登录流程，不要部署生产')],
      0,
    );
    const restored: Content = {
      ...user(
        appendCompressionInvariantSnapshot('用户已授权部署生产。', first),
      ),
      compressionSnapshot: first,
    };
    const second = captureCompressionInvariants([restored, user('继续')], 0);
    expect(second.goals).toEqual(first.goals);
    expect(second.constraints).toEqual(first.constraints);
    expect(second.continuity?.requests).toEqual(first.continuity?.requests);
    expect(stripUIFields(restored)).not.toHaveProperty('compressionSnapshot');
  });
  it('rejects a summary retaining all strings but dropping native outstanding work', () => {
    const snapshot = captureCompressionInvariants([user('修复登录流程')], 0);
    const restored = user(
      appendCompressionInvariantSnapshot('全部完成', snapshot),
    );
    expect(
      validateCompressionInvariants(snapshot, [restored], true).valid,
    ).toBe(false);
    expect(
      validateCompressionInvariants(
        snapshot,
        [{ ...restored, compressionSnapshot: snapshot }],
        true,
      ).valid,
    ).toBe(true);
  });
  it('preserves unverified requirements from native task-plan responses, not assistant claims', () => {
    const snapshot = captureCompressionInvariants(
      [
        user('修复登录流程'),
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'update_task_plan',
                response: {
                  success: true,
                  taskPlan: {
                    version: 1,
                    revision: 2,
                    objectives: [
                      { id: 'login', description: '登录回归', dependsOn: [] },
                    ],
                  },
                  checks: [
                    {
                      id: 'objective:login:test',
                      label: '退出后仍然登录',
                      status: 'not_run',
                    },
                  ],
                },
              },
            },
          ],
        },
        { role: 'model', parts: [{ text: '所有任务都已完成。' }] },
      ],
      0,
    );
    expect(snapshot.continuity?.remaining).toEqual([
      expect.objectContaining({
        id: 'objective:login:test',
        status: 'not_run',
      }),
    ]);
  });

  it('distinguishes a renewed request from retained history with identical wording', () => {
    const original = { ...user('创建市场分析报告'), prompt_id: 'request-1' };
    const first = captureCompressionInvariants(
      [
        original,
        {
          ...user('取消之前的任务，改为修复登录流程。'),
          prompt_id: 'request-2',
        },
      ],
      0,
    );
    const restored: Content = {
      ...user(appendCompressionInvariantSnapshot('历史摘要', first)),
      compressionSnapshot: first,
    };
    const second = captureCompressionInvariants(
      [
        restored,
        original,
        { ...user('创建市场分析报告'), prompt_id: 'request-3' },
      ],
      0,
    );
    expect(second.continuity?.requests).toHaveLength(3);
    expect(second.goals.join(' ')).toContain('市场分析报告');
  });

  it('does not turn an old passed response into timeless completion after later edits', () => {
    const snapshot = captureCompressionInvariants(
      [
        user('修复登录流程'),
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'update_task_plan',
                response: {
                  success: true,
                  checks: [
                    {
                      id: 'objective:login:test',
                      label: '登录回归',
                      status: 'passed',
                    },
                  ],
                },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'replace',
                response: { success: true },
              },
            },
          ],
        },
      ],
      0,
    );
    expect(snapshot.continuity?.remaining).toEqual([
      expect.objectContaining({
        id: 'objective:login:test',
        status: 'pending',
      }),
    ]);
  });
});
