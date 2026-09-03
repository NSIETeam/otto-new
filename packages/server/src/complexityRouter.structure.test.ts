/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import {
  refineComplexityFromObjectives,
  routeTurnComplexity,
} from './complexityRouter.js';
import type { TaskObjective } from './taskContract.js';
const tasks = (count: number): TaskObjective[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    description: '不同的具体交付物',
    sourceQuote: '实际用户要求',
    dependsOn: i ? [`t${i - 1}`] : [],
    criteria: [{ id: 'c', description: '检查结果', kind: 'manual' }],
    evidence: [],
  }));
describe('structure-refined routing', () => {
  it('uses dependency depth and acceptance count, without keyword scores', () => {
    const baseline = routeTurnComplexity({
      text: '处理一下',
      intent: 'change',
      riskLevel: 'local_write',
      toolFree: false,
    });
    const refined = refineComplexityFromObjectives(
      baseline,
      tasks(6),
      'local_write',
    );
    expect(refined.level).toBe('orchestrated');
    expect(refined.reasons).toContain('task_structure');
    expect(refined.budget.maxModelRounds).toBeGreaterThan(
      baseline.budget.maxModelRounds,
    );
    expect(refined.exposesWorkflowTool).toBe(baseline.exposesWorkflowTool);
  });
  it.each(['external_write', 'destructive'] as const)(
    'cannot relax %s limits',
    (riskLevel) => {
      const baseline = routeTurnComplexity({
        text: '发布',
        intent: 'change',
        riskLevel,
        toolFree: false,
      });
      const refined = refineComplexityFromObjectives(
        baseline,
        tasks(10),
        riskLevel,
      );
      expect(refined.budget).toEqual(baseline.budget);
      expect(refined.recommendedParallelism).toBe(1);
    },
  );
});
