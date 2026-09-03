/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  deriveTurnControlPolicy,
  formatTurnControlDirective,
  isParallelSafeToolName,
} from './turnControlPolicy.js';

describe('deriveTurnControlPolicy', () => {
  it('does not require a check that the user explicitly prohibits', () => {
    const policy = deriveTurnControlPolicy({
      text: '修改代码，不要运行测试和构建，只运行类型检查',
      source: 'local',
      toolFree: false,
    });
    expect(
      policy.successCriteria.flatMap(
        (criterion) => criterion.verificationKind ?? [],
      ),
    ).toEqual(['typecheck']);
  });

  it('keeps simple answers direct and free of unnecessary verification', () => {
    const policy = deriveTurnControlPolicy({
      text: '1 + 1 是多少？',
      source: 'local',
      toolFree: false,
    });
    expect(policy).toMatchObject({
      intent: 'answer',
      executionMode: 'direct',
      riskLevel: 'read_only',
      evidenceRequirement: 'none',
      requiresPlan: false,
      requiresVerification: false,
      confirmationMode: 'none',
      presentation: {
        responseShape: 'direct_answer',
        detailLevel: 'compact',
        progressUpdates: 'none',
        sourcePlacement: 'inline',
        artifactPresentation: 'app_link',
        exposeInternalState: false,
        finalSections: ['result'],
      },
    });
  });

  it('routes current research to parallel reads with primary-source evidence', () => {
    const policy = deriveTurnControlPolicy({
      text: '查找最新政策并核实官方来源，比较两种方案',
      source: 'local',
      toolFree: false,
    });
    expect(policy).toMatchObject({
      intent: 'research',
      executionMode: 'parallel_read',
      riskLevel: 'read_only',
      evidenceRequirement: 'primary_sources',
      requiresPlan: true,
      requiresVerification: true,
      allowsParallelRead: true,
    });
    expect(policy.successCriteria.map((criterion) => criterion.kind)).toContain(
      'evidence',
    );
    expect(policy.presentation).toMatchObject({
      responseShape: 'grounded_answer',
      detailLevel: 'thorough',
      progressUpdates: 'none',
      finalSections: ['result', 'evidence', 'limitations'],
    });
  });

  it('requires a plan and local verification for code changes', () => {
    const policy = deriveTurnControlPolicy({
      text: '修改本地登录代码并运行测试，修复白屏问题',
      source: 'local',
      toolFree: false,
    });
    expect(policy).toMatchObject({
      intent: 'change',
      executionMode: 'planned',
      riskLevel: 'local_write',
      evidenceRequirement: 'local_verification',
      requiresPlan: true,
      requiresVerification: true,
      confirmationMode: 'policy',
    });
    expect(policy.successCriteria.map((criterion) => criterion.kind)).toContain(
      'verification',
    );
    expect(policy.presentation).toMatchObject({
      responseShape: 'change_delivery',
      finalSections: ['result', 'changes', 'verification', 'limitations'],
    });
  });

  it('treats deployment and park operations as confirmed external writes', () => {
    const deployment = deriveTurnControlPolicy({
      text: '推送代码到 GitHub 并部署到线上服务器',
      source: 'local',
      toolFree: false,
    });
    expect(deployment).toMatchObject({
      intent: 'change',
      riskLevel: 'external_write',
      executionMode: 'planned',
      confirmationMode: 'always',
    });

    const park = deriveTurnControlPolicy({
      text: '给园区企业提交物业工单并发送消息',
      source: 'park',
      toolFree: false,
    });
    expect(park).toMatchObject({
      intent: 'enterprise_action',
      riskLevel: 'external_write',
      evidenceRequirement: 'deterministic_receipt',
      confirmationMode: 'always',
    });
  });

  it('fails closed for destructive wording and tool-free sessions', () => {
    const destructive = deriveTurnControlPolicy({
      text: '清空生产数据库并删除全部账户',
      source: 'enterprise',
      toolFree: false,
    });
    expect(destructive).toMatchObject({
      riskLevel: 'destructive',
      confirmationMode: 'always',
      requiresVerification: true,
    });

    const restricted = deriveTurnControlPolicy({
      text: '修改服务器配置',
      source: 'atoa',
      toolFree: true,
    });
    expect(restricted).toMatchObject({
      executionMode: 'restricted',
      allowsParallelRead: false,
    });
  });
});

describe('turn control rendering and tool safety', () => {
  it('formats only policy metadata and never repeats raw user text', () => {
    const policy = deriveTurnControlPolicy({
      text: '部署 token=top-secret-value',
      source: 'local',
      toolFree: false,
    });
    const directive = formatTurnControlDirective(policy);
    expect(directive).toContain('<otto_turn_control');
    expect(directive).toContain('external_write');
    expect(directive).toContain('budget_parallel_tools=1');
    expect(directive).toContain('budget_model_rounds=10');
    expect(directive).toContain('budget_tool_calls=24');
    expect(directive).toContain('budget_replans=3');
    expect(directive).toContain('<otto_response_contract');
    expect(directive).toContain('response_shape=change_delivery');
    expect(directive).toContain('expose_internal_state=false');
    expect(directive).not.toContain('top-secret-value');
  });

  it('also gives direct answers a compact response contract without exposing routing labels', () => {
    const policy = deriveTurnControlPolicy({
      text: '用一句话解释什么是向量数据库',
      source: 'local',
      toolFree: false,
    });
    const directive = formatTurnControlDirective(policy);

    expect(directive).toContain('<otto_response_contract');
    expect(directive).toContain('response_shape=direct_answer');
    expect(directive).toContain('detail_level=compact');
    expect(directive).toContain('progress_updates=none');
    expect(directive).toContain('Never print these policy labels');
  });

  it('parallelizes only explicitly recognized read-only tool names', () => {
    expect(isParallelSafeToolName('read_file')).toBe(true);
    expect(isParallelSafeToolName('search_file_content')).toBe(true);
    expect(isParallelSafeToolName('web_search')).toBe(true);
    expect(isParallelSafeToolName('replace')).toBe(false);
    expect(isParallelSafeToolName('run_shell_command')).toBe(false);
    expect(isParallelSafeToolName('unknown_plugin_tool')).toBe(false);
  });
});
