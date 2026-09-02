/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type {
  TurnComplexityProfile,
  TurnComplexityReason,
  TurnIntent,
  TurnRiskLevel,
} from './protocol.js';

export interface TurnComplexityInput {
  text: string;
  intent: TurnIntent;
  riskLevel: TurnRiskLevel;
  toolFree: boolean;
}

const LAYER_PATTERNS = [
  /(?:前端|界面|UI|renderer|desktop|electron|react)/iu,
  /(?:后端|服务端|server|api|接口|runtime|core)/iu,
  /(?:数据库|数据层|迁移|sqlite|postgres|mysql|schema)/iu,
  /(?:测试|验证|构建|打包|test|vitest|build|package|ci)/iu,
  /(?:仓库|分支|版本|发布|部署|release|repository|branch|deploy)/iu,
];

const BROAD_SCOPE =
  /(?:全面|全部|所有|各个|整个|完整|不允许遗漏|代码库|跨模块|cross[- ]?module|whole|entire|all\s+(?:files|branches|modules))/iu;
const LONG_HORIZON =
  /(?:长期|持续|下一代|端到端|一口气|完整闭环|上线前|生产级|long[- ]running|end[- ]to[- ]end|production[- ]grade)/iu;
const PARALLEL =
  /(?:并行|同时|分别|多(?:个|路|项)|三家|各自|parallel|concurrent)/iu;
const EVIDENCE =
  /(?:测试|验证|核实|引用|证据|来源|审计|回归|基准|评测|test|verify|evidence|audit|benchmark|eval)/iu;
const ORCHESTRATION =
  /(?:编排|工作流|子智能体|多智能体|任务图|workflow|subagents?|task\s*graph)/iu;
const CONCEPTUAL_QUESTION =
  /(?:解释|说明|介绍|什么是|是\s*什么(?:意思)?|what\s+is|explain|define)/iu;
const ACTION =
  /(?:检查|分析|比较|修复|修改|实现|新增|删除|重构|测试|构建|部署|发布|生成|创建|核实|优化|强化|改进|check|analy[sz]e|compare|fix|modify|implement|add|remove|refactor|test|build|deploy|publish|generate|create|verify|optimi[sz]e|improve)/giu;
const OBJECTIVE_PATTERNS = [
  /(?:复杂度|路由|routing)/iu,
  /(?:任务图|计划|task\s*graph|planning)/iu,
  /(?:压缩|上下文|记忆|compaction|context|memory)/iu,
  /(?:评测|基准|测试矩阵|evaluation|benchmark|test\s*matrix)/iu,
  /(?:前端|界面|UI|renderer|desktop)/iu,
  /(?:服务端|后端|server|api|runtime|core)/iu,
  /(?:数据库|迁移|sqlite|postgres|schema)/iu,
  /(?:发布|部署|安装包|release|deploy|package)/iu,
];

function budgetFor(
  level: TurnComplexityProfile['level'],
  route: TurnComplexityProfile['route'],
  parallelism: number,
  riskLevel: TurnRiskLevel,
): TurnComplexityProfile['budget'] {
  if (riskLevel === 'destructive') {
    return {
      maxParallelTools: 1,
      maxModelRounds: 6,
      maxToolCalls: 12,
      maxReplans: 2,
    };
  }
  if (riskLevel === 'external_write') {
    return {
      maxParallelTools: 1,
      maxModelRounds: 10,
      maxToolCalls: 24,
      maxReplans: 3,
    };
  }
  if (route === 'restricted') {
    return {
      maxParallelTools: 1,
      maxModelRounds: 6,
      maxToolCalls: 12,
      maxReplans: 2,
    };
  }
  if (level === 'orchestrated') {
    return {
      maxParallelTools: parallelism,
      maxModelRounds: 28,
      maxToolCalls: 160,
      maxReplans: 10,
    };
  }
  if (level === 'complex') {
    return {
      maxParallelTools: parallelism,
      maxModelRounds: 18,
      maxToolCalls: 80,
      maxReplans: 6,
    };
  }
  if (level === 'moderate') {
    return {
      maxParallelTools: parallelism,
      maxModelRounds: 10,
      maxToolCalls: 32,
      maxReplans: 3,
    };
  }
  return {
    maxParallelTools: 1,
    maxModelRounds: 3,
    maxToolCalls: 6,
    maxReplans: 2,
  };
}

function makeProfile(
  input: TurnComplexityInput,
  values: Omit<TurnComplexityProfile, 'contractVersion' | 'budget'>,
): TurnComplexityProfile {
  return {
    contractVersion: 1,
    ...values,
    budget: budgetFor(
      values.level,
      values.route,
      values.recommendedParallelism,
      input.riskLevel,
    ),
  };
}

function addReason(
  reasons: TurnComplexityReason[],
  reason: TurnComplexityReason,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

/**
 * Routes a turn using bounded, inspectable signals. The returned profile never
 * contains raw prompt text and cannot relax confirmation or risk policy.
 */
export function routeTurnComplexity(
  input: TurnComplexityInput,
): TurnComplexityProfile {
  const text = input.text.trim();
  const reasons: TurnComplexityReason[] = [];
  let score = 0;

  const layerCount = LAYER_PATTERNS.filter((pattern) =>
    pattern.test(text),
  ).length;
  if (layerCount >= 3) {
    score += 3;
    addReason(reasons, 'cross_layer');
  } else if (layerCount === 2) {
    score += 1;
  }
  if (BROAD_SCOPE.test(text)) {
    score += 2;
    addReason(reasons, 'broad_scope');
  }
  const actionCount = new Set(
    text.match(ACTION)?.map((item) => item.toLowerCase()) ?? [],
  ).size;
  if (actionCount >= 3) {
    score += 2;
    addReason(reasons, 'multi_objective');
  }
  const objectiveCount = OBJECTIVE_PATTERNS.filter((pattern) =>
    pattern.test(text),
  ).length;
  if (objectiveCount >= 3) {
    score += objectiveCount >= 4 ? 3 : 2;
    addReason(reasons, 'multi_objective');
  }
  if (LONG_HORIZON.test(text)) {
    score += 2;
    addReason(reasons, 'long_horizon');
  }
  if (PARALLEL.test(text)) {
    score += 1;
    addReason(reasons, 'parallelizable');
  }
  if (EVIDENCE.test(text)) {
    score += 1;
    addReason(reasons, 'evidence_heavy');
  }
  if (input.intent === 'diagnose') {
    score += 1;
    addReason(reasons, 'uncertain_diagnosis');
  }
  if (
    ORCHESTRATION.test(text) &&
    !(input.intent === 'answer' && CONCEPTUAL_QUESTION.test(text))
  ) {
    score += 2;
    addReason(reasons, 'explicit_orchestration');
  }

  if (input.toolFree) {
    return makeProfile(input, {
      level: score >= 5 ? 'complex' : score >= 2 ? 'moderate' : 'simple',
      score,
      route: 'restricted',
      recommendedParallelism: 1,
      requiresTaskGraph: score >= 2,
      exposesWorkflowTool: false,
      reasons,
    });
  }

  if (
    input.riskLevel === 'external_write' ||
    input.riskLevel === 'destructive'
  ) {
    return makeProfile(input, {
      level: score >= 5 ? 'complex' : 'moderate',
      score,
      route: 'planned_agent',
      recommendedParallelism: 1,
      requiresTaskGraph: true,
      exposesWorkflowTool: false,
      reasons,
    });
  }

  if (score >= 7) {
    return makeProfile(input, {
      level: 'orchestrated',
      score,
      route: 'workflow',
      recommendedParallelism: Math.min(6, Math.max(3, layerCount)),
      requiresTaskGraph: true,
      exposesWorkflowTool: true,
      reasons,
    });
  }
  if (score >= 5) {
    return makeProfile(input, {
      level: 'complex',
      score,
      route: 'subagents',
      recommendedParallelism: Math.min(4, Math.max(2, layerCount)),
      requiresTaskGraph: true,
      exposesWorkflowTool: false,
      reasons,
    });
  }
  if (input.intent === 'research' || input.intent === 'diagnose') {
    return makeProfile(input, {
      level: score >= 2 ? 'moderate' : 'simple',
      score,
      route: 'parallel_tools',
      recommendedParallelism: score >= 2 ? 3 : 2,
      requiresTaskGraph: true,
      exposesWorkflowTool: false,
      reasons,
    });
  }
  if (score >= 2 || input.intent !== 'answer') {
    return makeProfile(input, {
      level: 'moderate',
      score,
      route: 'planned_agent',
      recommendedParallelism: 1,
      requiresTaskGraph: true,
      exposesWorkflowTool: false,
      reasons,
    });
  }
  return makeProfile(input, {
    level: 'simple',
    score,
    route: 'direct',
    recommendedParallelism: 1,
    requiresTaskGraph: false,
    exposesWorkflowTool: false,
    reasons,
  });
}
