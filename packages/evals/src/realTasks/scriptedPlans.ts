/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import path from 'node:path';
import { CODE_FIXTURES } from './codeRepair.js';
import { scriptedProvider } from './loopbackProvider.js';
import type { RealTaskId } from './evidence.js';
/** Deliberately obvious fixed scripts: exercise the actual product, never score intelligence. */
export const SCRIPTED_REPAIRS = {
  'login-retry':
    'module.exports.login=async(send,refresh)=>{const r=await send("current");return r.status===401?send(await refresh()):r;};\n',
  'utc-display':
    'module.exports.parseTimestamp=value=>{if(typeof value!=="string"||!value.trim())return null;const s=value.trim().replace(" ","T");const n=Date.parse(/(?:Z|[+-]\\d{2}:?\\d{2})$/i.test(s)?s:s+"Z");return Number.isFinite(n)?n:null;};\n',
} as const;
export function createScriptedTaskProvider(
  caseId: RealTaskId,
  workspace: string,
) {
  return scriptedProvider((round) => {
    if (caseId === 'login-retry' || caseId === 'utc-display') {
      if (round === 1)
        return {
          name: 'read_file',
          args: {
            absolute_path: path.join(workspace, CODE_FIXTURES[caseId].file),
          },
        };
      if (round === 2)
        return {
          name: 'write_file',
          args: {
            file_path: path.join(workspace, CODE_FIXTURES[caseId].file),
            content: SCRIPTED_REPAIRS[caseId],
          },
        };
      if (round === 3) return { name: 'eval_validate', args: {} };
    }
    if (caseId === 'steer-stop-backend' && round < 3)
      return {
        name: 'write_file',
        args: {
          file_path: path.join(workspace, 'backend.cjs'),
          content:
            round === 1
              ? 'module.exports={retained:true,first:true};\n'
              : 'module.exports={oldDirection:true};\n',
        },
      };
    if (caseId === 'steer-replace-artifact' && round === 1)
      return {
        name: 'read_file',
        args: { absolute_path: path.join(workspace, 'backend.cjs') },
      };
    const format =
      caseId === 'dual-artifact'
        ? ['pptx', 'pdf', 'pptx', 'pdf'][round - 1]
        : caseId === 'ppt-preview' && round === 1
          ? 'pptx'
          : caseId === 'steer-replace-artifact' && round === 2
            ? 'pdf'
            : null;
    if (format)
      return {
        name: 'generate_document',
        args: {
          format: 'slides',
          output_format: format,
          output_path: path.join(workspace, `output.${format}`),
          title: 'Evaluation report',
          content: `# Overview\n\n- Isolated fixture\n\n---\n\n# ${caseId === 'dual-artifact' && round > 2 ? 'Progress revised' : 'Progress'}\n\n- Evidence collected\n\n---\n\n# Next Steps\n\n- Review results`,
        },
      };
    return '执行已结束；完成情况以独立验收为准，不宣称已通过全部检查。';
  });
}
