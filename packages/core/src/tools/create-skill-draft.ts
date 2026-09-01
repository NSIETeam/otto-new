/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { Type } from '@google/genai';
import {
  resolveAutoSkillUserDir,
  stageProactiveSkillDraft,
  type ProactiveSkillDraftInput,
} from '../orchestration/autoSkillGenerator.js';
import {
  BaseTool,
  Icon,
  type ToolCallConfirmationDetails,
  type ToolLocation,
  type ToolResult,
} from './tools.js';

export interface CreateSkillDraftParams {
  name: string;
  description: string;
  reason: string;
  skill_markdown: string;
  trigger_patterns?: string[];
  files?: Array<{ path: string; content: string }>;
}

const MAX_FILES = 50;
const MAX_TOTAL_CONTENT = 2 * 1024 * 1024;

export class CreateSkillDraftTool extends BaseTool<
  CreateSkillDraftParams,
  ToolResult
> {
  static readonly Name = 'create_skill_draft';

  constructor() {
    super(
      CreateSkillDraftTool.Name,
      'Create Skill Draft',
      '根据用户主动需求创建 Otto Skill 草稿。内容只写入个人 ~/.otto-user/skill-drafts 隔离区，随后自动做结构校验、静态测试、权限与风险分析并生成 .otto-skill 包；不会安装、覆盖内置 Skill或执行任何生成脚本。创建后必须让用户在“自动 Skill”候选界面查看并确认，才能安装到个人 Skill 目录。',
      Icon.LightBulb,
      {
        type: Type.OBJECT,
        properties: {
          name: {
            type: Type.STRING,
            description:
              '1-63 位 lowercase-kebab-case Skill 名称。不能与 Otto 内置 Skill 重名。',
          },
          description: {
            type: Type.STRING,
            description: '面向 Skill 发现的能力与触发语境说明。',
          },
          reason: {
            type: Type.STRING,
            description: '为什么根据当前用户需求创建该 Skill，展示在确认界面。',
          },
          skill_markdown: {
            type: Type.STRING,
            description: '完整 SKILL.md，必须包含 YAML frontmatter 和正文。',
          },
          trigger_patterns: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: '2-6 个应触发该 Skill 的用户表达。',
          },
          files: {
            type: Type.ARRAY,
            description:
              '除 SKILL.md 外的脚本、引用、测试或素材文本文件。生成后只静态检查，不执行脚本。',
            items: {
              type: Type.OBJECT,
              properties: {
                path: {
                  type: Type.STRING,
                  description: 'Skill 目录内的安全相对路径。',
                },
                content: { type: Type.STRING, description: 'UTF-8 文本内容。' },
              },
              required: ['path', 'content'],
            },
          },
        },
        required: ['name', 'description', 'reason', 'skill_markdown'],
      },
      true,
      false,
      false,
      false,
    );
  }

  override validateToolParams(params: CreateSkillDraftParams): string | null {
    if (!params || typeof params !== 'object') return 'parameters are required';
    if (
      typeof params.name !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(params.name)
    ) {
      return 'name must be 1-63 lowercase letters, numbers, or hyphens';
    }
    if (
      typeof params.description !== 'string' ||
      params.description.trim().length < 12
    ) {
      return 'description must explain capability and trigger context';
    }
    if (typeof params.reason !== 'string' || params.reason.trim().length < 8) {
      return 'reason must explain the active user need';
    }
    if (
      typeof params.skill_markdown !== 'string' ||
      params.skill_markdown.length < 80
    ) {
      return 'skill_markdown must contain a complete SKILL.md';
    }
    if (params.files !== undefined && !Array.isArray(params.files))
      return 'files must be an array';
    if ((params.files?.length ?? 0) > MAX_FILES)
      return `files cannot exceed ${MAX_FILES}`;
    const totalContent =
      params.skill_markdown.length +
      (params.files ?? []).reduce(
        (sum, file) =>
          sum + (typeof file?.content === 'string' ? file.content.length : 0),
        0,
      );
    if (totalContent > MAX_TOTAL_CONTENT)
      return 'Skill draft text cannot exceed 2 MiB';
    for (const file of params.files ?? []) {
      if (
        !file ||
        typeof file.path !== 'string' ||
        typeof file.content !== 'string'
      ) {
        return 'each file requires string path and content';
      }
      if (
        file.path.replaceAll('\\', '/').replace(/^\.\//u, '') === 'SKILL.md'
      ) {
        return 'files must not include SKILL.md; use skill_markdown';
      }
    }
    return null;
  }

  override getDescription(params: CreateSkillDraftParams): string {
    return `创建待确认 Skill 草稿：${params.name}`;
  }

  override toolLocations(_params: CreateSkillDraftParams): ToolLocation[] {
    return [{ path: path.join(resolveAutoSkillUserDir(), 'skill-drafts') }];
  }

  override async shouldConfirmExecute(
    _params: CreateSkillDraftParams,
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    // 只写隔离草稿区，不安装、不执行；真正安装由既有候选 UI 单独确认。
    return false;
  }

  override async execute(
    params: CreateSkillDraftParams,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Skill draft rejected: ${validationError}`,
        returnDisplay: validationError,
      };
    }
    const input: ProactiveSkillDraftInput = {
      name: params.name,
      description: params.description.trim(),
      reason: params.reason.trim(),
      skillContent: params.skill_markdown,
      triggerPatterns: params.trigger_patterns,
      files: params.files,
    };
    const candidate = await stageProactiveSkillDraft(input);
    const draft = candidate.draft;
    return {
      summary: draft?.validationPassed
        ? 'Skill draft ready for user review'
        : 'Skill draft created but needs fixes',
      llmContent: JSON.stringify(
        {
          candidateId: candidate.id,
          name: candidate.name,
          source: candidate.source,
          installed: false,
          executable: false,
          draft,
          nextStep:
            draft?.validationPassed && draft.packageReady
              ? '请用户在“自动 Skill”候选界面查看权限、文件变更和风险后确认安装。'
              : '先修复草稿验证或测试错误；当前不能安装。',
        },
        null,
        2,
      ),
      returnDisplay:
        draft?.validationPassed && draft.packageReady
          ? `✅ Skill 草稿已进入待确认区：${candidate.name}（尚未安装、未执行）`
          : `⚠️ Skill 草稿已保存但未通过检查：${candidate.name}（尚未安装、未执行）`,
    };
  }
}
