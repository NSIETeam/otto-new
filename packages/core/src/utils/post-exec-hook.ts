/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Post-Execution Hook: auto-learn after every tool execution.
 * Makes "work while learning" real - no manual documentation needed.
 */

import type { Config } from '../config/config.js';
import type { ToolResult } from '../tools/tools.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { randomUUID } from 'node:crypto';
import { getTurnExecutionGuard } from '../policy/turnExecutionGuardStore.js';

// Host-owned provenance, never a property that tool arguments can supply.
const learningWrappers = new WeakMap<
  object,
  { original: unknown; wrapper: unknown }
>();
export function originalLearningImplementation(tool: object): unknown {
  const current = (tool as { execute?: unknown }).execute;
  const recorded = learningWrappers.get(tool);
  return recorded && recorded.wrapper === current ? recorded.original : current;
}

export interface PostExecutionContext {
  toolName: string;
  action?: string;
  description: string;
  durationMs: number;
  success: boolean;
  resultSummary: string;
  employeeId?: string;
}

/**
 * Auto-learn from task execution.
 * Called asynchronously after every tool execution.
 * Failures are silent - learning is best-effort.
 */
async function autoLearn(
  config: Config,
  ctx: PostExecutionContext,
): Promise<void> {
  if (ctx.toolName === 'memory_manager') return;

  // Learning is an optional implicit write, not part of a native read's grant.
  // Check before importing/constructing the writer and again after the await.
  const request = {
    callId: `auto-learn:${randomUUID()}`,
    name: 'memory_manager',
    args: { action: 'learn' },
    nativeSafe: false,
  };
  try {
    getTurnExecutionGuard(config)?.(request);
  } catch {
    return;
  }

  try {
    const { MemoryManagerTool } = await import('../tools/memory-manager.js');
    try {
      getTurnExecutionGuard(config)?.(request);
    } catch {
      return;
    }
    const mem = new MemoryManagerTool(config);
    const durationMin = ctx.durationMs / 60000;
    const taskType = ctx.action
      ? `${ctx.toolName}_${ctx.action}`
      : ctx.toolName;

    await mem.execute(
      {
        action: 'learn',
        task_type: taskType,
        context: ctx.description,
        task_result: `${ctx.success ? 'success' : 'fail'} ${durationMin.toFixed(2)}min`,
        employee_id:
          ctx.employeeId || process.env.OTTO_EMPLOYEE_ID || 'unknown',
      },
      new AbortController().signal,
    );
  } catch (err: unknown) {
    // Learning should never break the main flow
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[PostExec] Learn failed:', msg);
  }
}

/**
 * Instrument all tools in a registry with post-execution learning.
 */
export function enableAutoLearning(
  registry: ToolRegistry,
  config: Config,
): void {
  if (!registry?.getAllTools) return;

  const tools = registry.getAllTools();
  let count = 0;

  for (const tool of tools) {
    // 企业私聊/A2A 参数可能包含对方问题或获准范围。该工具承诺仅做
    // 内存 confirmation relay，不能再被全局学习钩子持久化到文件。
    if (tool.name === 'enterprise_collaboration') continue;
    if (tool.name === 'memory_manager') continue;

    if (learningWrappers.get(tool)?.wrapper === tool.execute) continue;
    const originalExecute = tool.execute as (
      ...args: never[]
    ) => Promise<ToolResult>;

    tool.execute = function (...args: never[]): Promise<ToolResult> {
      const startTime = Date.now();
      const resultPromise = originalExecute.apply(tool, args);

      resultPromise
        .then((result: ToolResult) => {
          const durationMs = Date.now() - startTime;
          const desc = args[0]
            ? JSON.stringify(args[0]).substring(0, 200)
            : tool.name;
          const success =
            typeof result.llmContent === 'string' &&
            !result.llmContent.includes('FAIL');
          const summary =
            typeof result.returnDisplay === 'string'
              ? result.returnDisplay
              : String(result.returnDisplay || '');
          const input = args[0] as Record<string, unknown> | undefined;
          const action =
            typeof input?.action === 'string'
              ? input.action
              : typeof input?.operation === 'string'
                ? input.operation
                : undefined;

          autoLearn(config, {
            toolName: tool.name,
            action,
            description: desc,
            durationMs,
            success,
            resultSummary: summary,
            employeeId:
              typeof input?.employee_id === 'string'
                ? input.employee_id
                : process.env.OTTO_EMPLOYEE_ID,
          }).catch(() => {});
        })
        .catch(() => {});

      return resultPromise;
    };

    learningWrappers.set(tool, {
      original: originalExecute,
      wrapper: tool.execute,
    });

    count++;
  }

  console.log(`[PostExec] Auto-learning enabled for ${count} tools`);
}
