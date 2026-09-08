/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { WriteFileTool } from '../tools/write-file.js';
import { EditTool } from '../tools/edit.js';
import { ReadFileTool } from '../tools/read-file.js';
import { ReadManyFilesTool } from '../tools/read-many-files.js';
import { LSTool } from '../tools/ls.js';
import { GlobTool } from '../tools/glob.js';
import { GrepTool } from '../tools/grep.js';
import { AskUserQuestionTool } from '../tools/ask-user-question.js';
import { originalLearningImplementation } from '../utils/post-exec-hook.js';
import { GenerateSafeDocumentTool } from '../tools/generate-safe-document.js';
import {
  getTurnExecutionGuard,
  type GuardedToolCall,
} from './turnExecutionGuardStore.js';
export { installTurnExecutionGuard } from './turnExecutionGuardStore.js';
export type { GuardedToolCall } from './turnExecutionGuardStore.js';
// Tools also reach the executor through Config. Resolve this fixed allow-list
// only at dispatch, after the module graph has initialized; eagerly reading a
// class here breaks callers that import a tool before importing the executor.
function nativePrototypes() {
  return [
    WriteFileTool,
    EditTool,
    ReadFileTool,
    ReadManyFilesTool,
    LSTool,
    GlobTool,
    GrepTool,
    AskUserQuestionTool,
    GenerateSafeDocumentTool,
  ].map((tool) => ({ name: tool.Name, prototype: tool.prototype }));
}
export function assertTurnExecutionAllowed(
  config: object,
  call: GuardedToolCall,
  implementation?: object,
): void {
  const guard = getTurnExecutionGuard(config);
  if (!guard) return;
  guard(
    implementation
      ? {
          ...call,
          nativeSafe: nativePrototypes().some(
            ({ name, prototype }) =>
              call.name === name &&
              Object.getPrototypeOf(implementation) === prototype &&
              originalLearningImplementation(implementation) ===
                prototype.execute,
          ),
        }
      : call,
  );
}
