/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it } from 'vitest';
import { deriveTurnControlPolicy } from './turnControlPolicy.js';
import { TaskGraphCoordinator } from './taskGraph.js';

describe('TaskGraphCoordinator', () => {
  it('builds an explicit dependency graph for a complex change', () => {
    const policy = deriveTurnControlPolicy({
      text: '全面检查前端和服务端，修复问题，补充测试并完成构建',
      source: 'local',
      toolFree: false,
    });
    const graph = new TaskGraphCoordinator(policy).snapshot();

    expect(graph.revision).toBe(1);
    expect(graph.nodes.map((node) => node.kind)).toEqual([
      'understand',
      'gather',
      'execute',
      'verify',
      'deliver',
    ]);
    expect(
      graph.nodes.find((node) => node.kind === 'execute')?.dependsOn,
    ).toEqual(['graph-gather']);
    expect(
      graph.nodes.find((node) => node.kind === 'verify')?.dependsOn,
    ).toEqual(['graph-execute']);
  });

  it('advances graph nodes from observable tools rather than model claims', () => {
    const policy = deriveTurnControlPolicy({
      text: '检查并修改登录代码，然后运行测试',
      source: 'local',
      toolFree: false,
    });
    const graph = new TaskGraphCoordinator(policy);
    graph.observeTools([
      {
        name: 'read_file',
        status: 'success',
        mutating: false,
        verification: false,
      },
      {
        name: 'replace',
        status: 'success',
        mutating: true,
        verification: false,
      },
      {
        name: 'npm_test',
        status: 'success',
        mutating: true,
        verification: true,
      },
    ]);

    const snapshot = graph.snapshot();
    expect(snapshot.nodes.find((node) => node.kind === 'gather')?.status).toBe(
      'completed',
    );
    expect(snapshot.nodes.find((node) => node.kind === 'execute')?.status).toBe(
      'completed',
    );
    expect(snapshot.nodes.find((node) => node.kind === 'verify')?.status).toBe(
      'completed',
    );
  });

  it('replans only unfinished work and preserves completed evidence', () => {
    const policy = deriveTurnControlPolicy({
      text: '全面检查并修复登录问题，完成测试',
      source: 'local',
      toolFree: false,
    });
    const graph = new TaskGraphCoordinator(policy);
    graph.observeTools([
      {
        name: 'read_file',
        status: 'success',
        mutating: false,
        verification: false,
      },
    ]);
    graph.applyAdaptation({
      revision: 1,
      timestamp: Date.now(),
      category: 'stale_state',
      action: 'switch_strategy',
      toolName: 'replace',
      attempt: 1,
    });

    const snapshot = graph.snapshot();
    expect(snapshot.revision).toBe(2);
    expect(
      snapshot.nodes.find((node) => node.id === 'graph-gather')?.status,
    ).toBe('completed');
    expect(snapshot.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'recover',
        status: 'pending',
        strategy: 'refresh_state',
      }),
    );
    expect(snapshot.revisions.at(-1)?.preservedNodeIds).toContain(
      'graph-gather',
    );
    expect(snapshot.revisions.at(-1)?.reason).not.toContain('secret');

    graph.observeTools([
      {
        name: 'replace',
        status: 'success',
        mutating: true,
        verification: false,
      },
    ]);
    expect(
      graph.snapshot().nodes.find((node) => node.kind === 'recover')?.status,
    ).toBe('completed');
  });

  it('emits a bounded internal directive without user text or hidden payloads', () => {
    const policy = deriveTurnControlPolicy({
      text: '修复 secret-token-123 对应的问题',
      source: 'local',
      toolFree: false,
    });
    const graph = new TaskGraphCoordinator(policy);
    const directive = graph.directive();
    expect(directive).toContain('<otto_task_graph');
    expect(directive).toContain('graph-verify');
    expect(directive).not.toContain('secret-token-123');
    expect(directive.length).toBeLessThan(2_400);
  });

  it('blocks dependent work on failure and cannot deliver prematurely', () => {
    const policy = deriveTurnControlPolicy({
      text: '修改登录代码并运行测试',
      source: 'local',
      toolFree: false,
    });
    const graph = new TaskGraphCoordinator(policy);
    graph.observeTools([
      {
        name: 'replace',
        status: 'error',
        mutating: true,
        verification: false,
        evidenceId: 'tool-replace-1',
      },
    ]);

    expect(
      graph.snapshot().nodes.find((node) => node.kind === 'execute')?.status,
    ).toBe('failed');
    expect(
      graph.snapshot().nodes.find((node) => node.kind === 'verify')?.status,
    ).toBe('blocked');
    expect(graph.markDelivered()).toBe(false);
    expect(graph.validate()).toMatchObject({
      readyToDeliver: false,
      blockedNodeIds: expect.arrayContaining(['graph-verify', 'graph-deliver']),
    });
  });

  it('does not complete a parallel gather when any required read fails', () => {
    const policy = deriveTurnControlPolicy({
      text: '查找并比较多个官方来源',
      source: 'local',
      toolFree: false,
    });
    const graph = new TaskGraphCoordinator(policy);
    graph.observeTools([
      {
        name: 'web_search',
        status: 'success',
        mutating: false,
        verification: false,
        evidenceId: 'source-1',
      },
      {
        name: 'read_url',
        status: 'error',
        mutating: false,
        verification: false,
      },
    ]);

    expect(
      graph.snapshot().nodes.find((node) => node.kind === 'gather')?.status,
    ).toBe('failed');
    expect(graph.markDelivered()).toBe(false);
  });

  it('records observable evidence, unblocks replanned work, and restores a valid snapshot', () => {
    const policy = deriveTurnControlPolicy({
      text: '检查并修改登录代码，然后运行测试',
      source: 'local',
      toolFree: false,
    });
    const graph = new TaskGraphCoordinator(policy);
    graph.observeTools([
      {
        name: 'read_file',
        status: 'success',
        mutating: false,
        verification: false,
        evidenceId: 'read-1',
      },
      {
        name: 'replace',
        status: 'error',
        mutating: true,
        verification: false,
        evidenceId: 'replace-1',
      },
    ]);
    graph.applyAdaptation({
      revision: 1,
      timestamp: 10,
      category: 'stale_state',
      action: 'switch_strategy',
      toolName: 'replace',
      attempt: 1,
    });
    graph.observeTools([
      {
        name: 'replace',
        status: 'success',
        mutating: true,
        verification: false,
        evidenceId: 'replace-2',
      },
      {
        name: 'npm_test',
        status: 'success',
        mutating: true,
        verification: true,
        evidenceId: 'test-1',
      },
    ]);
    expect(graph.markDelivered()).toBe(true);

    const snapshot = graph.snapshot();
    expect(
      snapshot.nodes.find((node) => node.kind === 'gather')?.evidenceIds,
    ).toContain('read-1');
    expect(
      snapshot.nodes.find((node) => node.kind === 'execute')?.evidenceIds,
    ).toContain('replace-2');
    expect(
      snapshot.nodes.find((node) => node.kind === 'verify')?.evidenceIds,
    ).toContain('test-1');
    expect(snapshot.nodes.every((node) => node.status === 'completed')).toBe(
      true,
    );
    expect(TaskGraphCoordinator.restore(policy, snapshot).snapshot()).toEqual(
      snapshot,
    );
  });

  it('rejects a corrupt restored graph with unknown dependencies', () => {
    const policy = deriveTurnControlPolicy({
      text: '修改登录代码并运行测试',
      source: 'local',
      toolFree: false,
    });
    const snapshot = new TaskGraphCoordinator(policy).snapshot();
    snapshot.nodes[1].dependsOn = ['graph-does-not-exist'];
    expect(() => TaskGraphCoordinator.restore(policy, snapshot)).toThrow(
      /unknown dependency/iu,
    );
  });

  it('rejects a snapshot that claims delivery before dependencies complete', () => {
    const policy = deriveTurnControlPolicy({
      text: '修改登录代码并运行测试',
      source: 'local',
      toolFree: false,
    });
    const snapshot = new TaskGraphCoordinator(policy).snapshot();
    snapshot.nodes.find((node) => node.kind === 'deliver')!.status =
      'completed';
    expect(() => TaskGraphCoordinator.restore(policy, snapshot)).toThrow(
      /premature delivery/iu,
    );
  });
});
