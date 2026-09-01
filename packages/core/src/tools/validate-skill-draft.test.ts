/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ValidateSkillDraftTool } from './validate-skill-draft.js';

let root: string;
let projectRoot: string;
let previousUserDir: string | undefined;

function writeValidSkill(parent: string, name = 'project-helper'): string {
  const skillDir = path.join(parent, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      'description: 整理项目交付信息。当用户要求生成项目交付清单或项目验收摘要时使用。',
      '---',
      '# 项目交付助手',
      '',
      '读取项目范围、完成证据和遗留风险，生成结构化交付清单。不得虚构测试结果或完成状态。',
      '',
      '## 验收',
      '',
      '每项结论都指向可复核证据，并明确区分已完成、待验证和受阻事项。',
    ].join('\n'),
    'utf8',
  );
  return skillDir;
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'otto-validate-skill-tool-'));
  projectRoot = path.join(root, 'project');
  mkdirSync(projectRoot, { recursive: true });
  previousUserDir = process.env['OTTO_USER_DIR'];
  process.env['OTTO_USER_DIR'] = path.join(root, 'user');
});

afterEach(() => {
  if (previousUserDir === undefined) delete process.env['OTTO_USER_DIR'];
  else process.env['OTTO_USER_DIR'] = previousUserDir;
  rmSync(root, { recursive: true, force: true });
});

function tool(): ValidateSkillDraftTool {
  return new ValidateSkillDraftTool({
    getTargetDir: () => projectRoot,
  });
}

describe('ValidateSkillDraftTool', () => {
  it('在当前项目内只读验证并返回结构化报告', async () => {
    const skillPath = writeValidSkill(
      path.join(projectRoot, '.otto', 'skills'),
    );

    const result = await tool().execute(
      { skill_path: skillPath },
      new AbortController().signal,
    );
    const report = JSON.parse(String(result.llmContent)) as { valid: boolean };

    expect(report.valid).toBe(true);
    expect(result.returnDisplay).toContain('验证通过');
  });

  it('允许个人 Otto Skills，但拒绝任意外部目录', () => {
    const personal = writeValidSkill(
      path.join(process.env['OTTO_USER_DIR']!, 'skills'),
    );
    const outside = writeValidSkill(
      path.join(root, 'outside'),
      'outside-helper',
    );
    const validator = tool();

    expect(validator.validateToolParams({ skill_path: personal })).toBeNull();
    expect(validator.validateToolParams({ skill_path: outside })).toContain(
      'current project, personal Otto skills directory, or personal Skill draft area',
    );
  });
});
