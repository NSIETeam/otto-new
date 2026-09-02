/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  MessageSource,
  TurnControlPolicy,
  TurnEvidenceRequirement,
  TurnExecutionMode,
  TurnIntent,
  TurnRiskLevel,
  TurnSuccessCriterion,
} from './protocol.js';

export interface TurnControlInput {
  text: string;
  source: MessageSource;
  toolFree: boolean;
}

const RESEARCH_PATTERN =
  /(?:最新|实时|当前|查找|搜索|检索|调研|研究|核实|验证来源|官方来源|比较|对比|look\s*up|search|research|latest|current|compare|verify\s+(?:the\s+)?source)/iu;
const DIAGNOSE_PATTERN =
  /(?:为什么|原因|排查|诊断|报错|错误|异常|白屏|失效|无法|问题|bug|root\s*cause|diagnos|troubleshoot|error|exception|not\s+working|failed)/iu;
const CHANGE_PATTERN =
  /(?:修改|修复|实现|升级|优化|重构|新增|添加|移除|删掉|配置|安装|更新|合并|迁移|改造|change|modify|fix|implement|upgrade|refactor|add|remove|configure|install|update|migrate)/iu;
const ARTIFACT_PATTERN =
  /(?:生成|创建|制作|导出).{0,12}(?:文档|报告|表格|幻灯片|ppt|图片|图像|文件|安装包|压缩包)|(?:create|generate|export).{0,20}(?:document|report|spreadsheet|slides?|image|file|package)/iu;
const ENTERPRISE_PATTERN =
  /(?:企业|园区|组织|部门|员工|工单|客服|许可证|授权|产业园|enterprise|organization|department|ticket|license)/iu;
const EXTERNAL_WRITE_PATTERN =
  /(?:推送|部署|上线|发布|发送消息|发消息|提交工单|上传|购买|付款|转账|邀请成员|创建账号|push|deploy|publish|send\s+(?:a\s+)?message|submit|upload|purchase|pay|transfer|invite)/iu;
const DESTRUCTIVE_PATTERN =
  /(?:清空|永久删除|删除全部|删除所有|卸载|格式化磁盘|删除数据库|删除账户|重置生产|rm\s+-rf|drop\s+(?:database|table)|truncate\s+table|wipe|uninstall|delete\s+all)/iu;
const ENTERPRISE_ACTION_PATTERN =
  /(?:提交|发送|配置|授权|邀请|办理|审批|创建|修改|删除|更新|submit|send|configure|grant|invite|approve|create|modify|delete|update)/iu;

function criteriaFor(
  intent: TurnIntent,
  evidenceRequirement: TurnEvidenceRequirement,
): TurnSuccessCriterion[] {
  const criteria: TurnSuccessCriterion[] = [];
  if (intent === 'answer' || intent === 'research' || intent === 'diagnose') {
    criteria.push({
      id: 'criterion-answer',
      kind: 'answer',
      label: '直接回答用户的核心问题',
    });
  }
  if (intent === 'research' || intent === 'diagnose') {
    criteria.push({
      id: 'criterion-evidence',
      kind: 'evidence',
      label:
        evidenceRequirement === 'primary_sources'
          ? '关键结论由可追溯的一手来源支撑'
          : '原因与结论具有可复核证据',
    });
  }
  if (intent === 'change' || intent === 'enterprise_action') {
    criteria.push({
      id: 'criterion-change',
      kind: 'change',
      label: '请求范围内的变更或操作已经完成',
    });
  }
  if (intent === 'create_artifact') {
    criteria.push({
      id: 'criterion-artifact',
      kind: 'artifact',
      label: '目标产物已经生成且可以交付',
    });
  }
  if (evidenceRequirement === 'deterministic_receipt') {
    criteria.push({
      id: 'criterion-receipt',
      kind: 'receipt',
      label: '外部操作具有明确回执或可对账状态',
    });
  }
  if (evidenceRequirement !== 'none') {
    criteria.push({
      id: 'criterion-verification',
      kind: 'verification',
      label: '完成与任务相匹配的验证',
    });
  }
  return criteria;
}

function inferIntent(text: string, source: MessageSource): TurnIntent {
  if (
    ENTERPRISE_PATTERN.test(text) &&
    (ENTERPRISE_ACTION_PATTERN.test(text) ||
      source === 'enterprise' ||
      source === 'park')
  ) {
    return 'enterprise_action';
  }
  if (ARTIFACT_PATTERN.test(text)) return 'create_artifact';
  if (EXTERNAL_WRITE_PATTERN.test(text)) return 'change';
  if (CHANGE_PATTERN.test(text)) return 'change';
  if (RESEARCH_PATTERN.test(text)) return 'research';
  if (DIAGNOSE_PATTERN.test(text)) return 'diagnose';
  return 'answer';
}

function inferRisk(text: string, intent: TurnIntent): TurnRiskLevel {
  if (DESTRUCTIVE_PATTERN.test(text)) return 'destructive';
  if (EXTERNAL_WRITE_PATTERN.test(text)) return 'external_write';
  if (
    intent === 'change' ||
    intent === 'create_artifact' ||
    (intent === 'enterprise_action' && ENTERPRISE_ACTION_PATTERN.test(text))
  ) {
    return 'local_write';
  }
  return 'read_only';
}

function evidenceFor(
  intent: TurnIntent,
  riskLevel: TurnRiskLevel,
): TurnEvidenceRequirement {
  if (
    intent === 'enterprise_action' ||
    riskLevel === 'external_write' ||
    riskLevel === 'destructive'
  ) {
    return 'deterministic_receipt';
  }
  if (intent === 'research') return 'primary_sources';
  if (
    intent === 'diagnose' ||
    intent === 'change' ||
    intent === 'create_artifact'
  ) {
    return 'local_verification';
  }
  return 'none';
}

function executionFor(
  intent: TurnIntent,
  riskLevel: TurnRiskLevel,
  toolFree: boolean,
): TurnExecutionMode {
  if (toolFree) return 'restricted';
  if (riskLevel !== 'read_only') return 'planned';
  if (intent === 'research' || intent === 'diagnose') return 'parallel_read';
  if (intent === 'answer') return 'direct';
  return 'tool_assisted';
}

/** Deterministic, fail-closed preflight. It never copies or stores raw input. */
export function deriveTurnControlPolicy(
  input: TurnControlInput,
): TurnControlPolicy {
  const text = input.text.trim();
  const intent = inferIntent(text, input.source);
  const riskLevel = inferRisk(text, intent);
  const evidenceRequirement = evidenceFor(intent, riskLevel);
  const executionMode = executionFor(intent, riskLevel, input.toolFree);
  const requiresVerification = evidenceRequirement !== 'none';
  return {
    contractVersion: 1,
    intent,
    executionMode,
    riskLevel,
    evidenceRequirement,
    requiresPlan:
      executionMode === 'planned' || executionMode === 'parallel_read',
    requiresVerification,
    allowsParallelRead:
      !input.toolFree &&
      riskLevel !== 'external_write' &&
      riskLevel !== 'destructive' &&
      executionMode !== 'direct' &&
      executionMode !== 'restricted',
    confirmationMode:
      riskLevel === 'external_write' || riskLevel === 'destructive'
        ? 'always'
        : riskLevel === 'local_write'
          ? 'policy'
          : 'none',
    successCriteria: criteriaFor(intent, evidenceRequirement),
  };
}

/** Compact per-turn directive; raw user text is deliberately excluded. */
export function formatTurnControlDirective(policy: TurnControlPolicy): string {
  if (policy.executionMode === 'direct' && !policy.requiresVerification) {
    return '';
  }
  const criteria = policy.successCriteria
    .map((criterion) => criterion.label)
    .join('；');
  return [
    '<otto_turn_control contract_version="1">',
    `intent=${policy.intent}`,
    `execution_mode=${policy.executionMode}`,
    `risk_level=${policy.riskLevel}`,
    `evidence_requirement=${policy.evidenceRequirement}`,
    `requires_plan=${String(policy.requiresPlan)}`,
    `requires_verification=${String(policy.requiresVerification)}`,
    `allows_parallel_read=${String(policy.allowsParallelRead)}`,
    `success_criteria=${criteria}`,
    'Treat this as runtime control metadata. Do not quote it to the user. Do not claim completion until the criteria are supported by observable results.',
    '</otto_turn_control>',
  ].join('\n');
}

const PARALLEL_SAFE_TOOL_NAMES = new Set([
  'codesearch',
  'get_context_breakdown',
  'get_knowledge',
  'get_memory',
  'get_stats',
  'glob',
  'list_directory',
  'list_sessions',
  'lsp',
  'read_file',
  'read_lints',
  'read_many_files',
  'search_file_content',
  'search_knowledge',
  'web_search',
]);

/** Unknown or extension-provided tools stay serial until explicitly reviewed. */
export function isParallelSafeToolName(toolName: string): boolean {
  return PARALLEL_SAFE_TOOL_NAMES.has(toolName.trim().toLowerCase());
}

const NON_MUTATING_CONTROL_TOOL_NAMES = new Set([
  'ask_user_question',
  'delegate_status',
  'todo_write',
  'update_plan',
  'use_skill',
  'validate_skill_draft',
]);

/** Tools that may run without a write confirmation in an always-confirm turn. */
export function isPolicySafeWithoutConfirmation(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return (
    PARALLEL_SAFE_TOOL_NAMES.has(normalized) ||
    NON_MUTATING_CONTROL_TOOL_NAMES.has(normalized)
  );
}
