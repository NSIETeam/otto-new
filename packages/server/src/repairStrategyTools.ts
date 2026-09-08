/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { Type, type FunctionDeclaration } from '@google/genai';
export const REPAIR_PLAN_TOOL_NAME = 'plan_delivery_repair';
export const REPAIR_FORMAT_TOOL_NAME = 'prepare_repair_format';
export const REPAIR_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: REPAIR_PLAN_TOOL_NAME,
    description:
      'At pre-delivery only, after a failed native check and fresh reads: compare 1-3 concrete local repair alternatives. Native code selects the smallest eligible risk/cost scope, not semantic correctness. Two batches maximum, four files per batch. Include only already changed files, directly imported observed check inputs, and sibling new tests. Existing observed acceptance tests are read-only in automatic repair; fix implementation or add a separate regression. All original acceptance remains mandatory. This is NOT permission to execute; normal file confirmation still applies. Use the returned selection only, then rerun affected checks and bind new receipts. No deployment, sends, dependencies, shell commands or automatic rollback.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        requestRevision: { type: Type.INTEGER },
        failedToolCallId: { type: Type.STRING },
        alternatives: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              reason: { type: Type.STRING },
              files: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
            required: ['id', 'reason', 'files'],
          },
        },
      },
      required: ['requestRevision', 'failedToolCallId', 'alternatives'],
    },
  },
  {
    name: REPAIR_FORMAT_TOOL_NAME,
    description:
      'Prepare formatted content of one freshly read selected repair file using Otto bundled parsers only. No writes, shell, config loading, plugins or download. Apply returned content with write_file through normal permission and audit, then revalidate. Maximum 256 KB input. Unsupported formats require ordinary scoped editing, not installing a formatter.',
    parameters: {
      type: Type.OBJECT,
      properties: { file_path: { type: Type.STRING } },
      required: ['file_path'],
    },
  },
];
