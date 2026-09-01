/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import os from 'node:os';
import { Type } from '@google/genai';
import { isWithinRoot } from '../utils/fileUtils.js';
import { validateSkillDraft } from '../skills/skill-draft-validator.js';
import {
  BaseTool,
  Icon,
  type ToolCallConfirmationDetails,
  type ToolLocation,
  type ToolResult,
} from './tools.js';

export interface ValidateSkillDraftParams {
  skill_path: string;
}

interface SkillValidationConfig {
  getTargetDir(): string;
}

function personalSkillRoots(): string[] {
  const userRoot =
    process.env['OTTO_USER_DIR']?.trim() ||
    path.join(os.homedir(), '.otto-user');
  return [path.join(userRoot, 'skills'), path.join(userRoot, 'skill-drafts')];
}

export class ValidateSkillDraftTool extends BaseTool<
  ValidateSkillDraftParams,
  ToolResult
> {
  static readonly Name = 'validate_skill_draft';

  constructor(private readonly config: SkillValidationConfig) {
    super(
      ValidateSkillDraftTool.Name,
      'Validate Skill Draft',
      '离线、只读地验证一个 Otto Skill 候选目录。检查 SKILL.md 结构、名称一致性、体积、符号链接、敏感文件、疑似令牌和二进制可执行文件；允许当前项目、个人 Skill 目录和隔离草稿区，不会执行候选脚本、修改文件或访问网络。创建或更新 Skill 后、安装前必须调用。',
      Icon.Info,
      {
        type: Type.OBJECT,
        properties: {
          skill_path: {
            type: Type.STRING,
            description:
              '候选 Skill 目录的绝对路径。仅允许当前项目或个人 ~/.otto-user/skills 下的目录。',
          },
        },
        required: ['skill_path'],
      },
      true,
      false,
      false,
    );
  }

  override validateToolParams(params: ValidateSkillDraftParams): string | null {
    if (!params?.skill_path || typeof params.skill_path !== 'string') {
      return 'skill_path is required and must be a string';
    }
    if (!path.isAbsolute(params.skill_path)) {
      return 'skill_path must be an absolute directory path';
    }
    const candidate = path.resolve(params.skill_path);
    const allowed = [
      path.resolve(this.config.getTargetDir()),
      ...personalSkillRoots().map((root) => path.resolve(root)),
    ];
    if (!allowed.some((root) => isWithinRoot(candidate, root))) {
      return 'skill_path must be inside the current project, personal Otto skills directory, or personal Skill draft area';
    }
    return null;
  }

  override getDescription(params: ValidateSkillDraftParams): string {
    return `验证 Skill 候选：${params.skill_path}`;
  }

  override toolLocations(params: ValidateSkillDraftParams): ToolLocation[] {
    return [{ path: params.skill_path }];
  }

  override async shouldConfirmExecute(
    _params: ValidateSkillDraftParams,
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    return false;
  }

  override async execute(
    params: ValidateSkillDraftParams,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Skill validation request rejected: ${validationError}`,
        returnDisplay: validationError,
      };
    }
    const report = validateSkillDraft(params.skill_path);
    return {
      summary: report.valid
        ? 'Skill draft is valid'
        : 'Skill draft needs changes',
      llmContent: JSON.stringify(report, null, 2),
      returnDisplay: report.valid
        ? `✅ Skill 验证通过（${report.stats.fileCount} 个文件）`
        : `❌ Skill 验证失败（${report.errors.length} 个问题）`,
    };
  }
}
