/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import {
  installConfirmedSkillDraft,
  stageSkillDraft,
  type SkillDraftFileInput,
} from './skillDraftWorkflow.js';

const tempRoots: string[] = [];

async function userRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-skill-draft-'));
  tempRoots.push(root);
  return root;
}

function skillMarkdown(name: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: 为用户生成可复核报告。当用户要求创建、整理或导出结构化报告时使用。`,
    '---',
    '# 报告工作流',
    '',
    '先核对输入、输出位置和验收条件，再整理事实、推断和待确认事项。',
    '',
    '不得编造数据、覆盖未授权文件或把本地内容上传到未声明的外部服务。交付前检查文件存在、结构完整并说明限制。',
  ].join('\n');
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('SkillDraftWorkflow', () => {
  it('只在隔离草稿区校验和打包，确认前不安装', async () => {
    const root = await userRoot();
    const summary = await stageSkillDraft({
      userDir: root,
      candidateId: 'skill_draft_safe_report',
      name: 'safe-report',
      files: [{ path: 'SKILL.md', content: skillMarkdown('safe-report') }],
    });

    expect(summary.validationPassed).toBe(true);
    expect(summary.packageReady).toBe(true);
    await expect(
      fs.access(path.join(root, 'skills', 'safe-report', 'SKILL.md')),
    ).rejects.toThrow();
    const packagePath = path.join(root, summary.packageRelativePath!);
    const archive = await JSZip.loadAsync(await fs.readFile(packagePath));
    expect(archive.file('safe-report/SKILL.md')).toBeTruthy();
    expect(archive.file('otto-draft-manifest.json')).toBeTruthy();

    const installed = await installConfirmedSkillDraft(root, summary);
    expect(installed).toBe(
      path.join(root, 'skills', 'safe-report', 'SKILL.md'),
    );
    await expect(fs.readFile(installed, 'utf8')).resolves.toContain(
      'name: safe-report',
    );
  });

  it('脚本草稿显示权限和风险，但生成、测试、打包、安装均不执行', async () => {
    const root = await userRoot();
    const sentinel = path.join(root, 'must-not-exist.txt');
    const script = [
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(sentinel)}, 'executed');`,
    ].join('\n');
    const files: SkillDraftFileInput[] = [
      { path: 'SKILL.md', content: skillMarkdown('script-report') },
      { path: 'scripts/run.cjs', content: script },
    ];
    const summary = await stageSkillDraft({
      userDir: root,
      candidateId: 'skill_draft_script_report',
      name: 'script-report',
      files,
    });

    expect(summary.risk.scriptFiles).toEqual(['scripts/run.cjs']);
    expect(summary.risk.permissions).toContain('写入或删除本地文件');
    expect(summary.risk.executionBlocked).toBe(true);
    expect(summary.tests).toContainEqual(
      expect.objectContaining({
        name: '脚本行为测试',
        status: 'needs-review',
      }),
    );
    await expect(fs.access(sentinel)).rejects.toThrow();

    await installConfirmedSkillDraft(root, summary);
    await expect(fs.access(sentinel)).rejects.toThrow();
  });

  it('结构不合格的草稿可以留待修复，但不能打包或安装', async () => {
    const root = await userRoot();
    const summary = await stageSkillDraft({
      userDir: root,
      candidateId: 'skill_draft_invalid_report',
      name: 'invalid-report',
      files: [
        {
          path: 'SKILL.md',
          content: '---\nname: wrong-name\ndescription: 太短\n---\n坏草稿',
        },
      ],
    });

    expect(summary.validationPassed).toBe(false);
    expect(summary.packageReady).toBe(false);
    expect(summary.packageRelativePath).toBeUndefined();
    await expect(installConfirmedSkillDraft(root, summary)).rejects.toThrow(
      '不能安装',
    );
  });

  it('拒绝覆盖官方内置 Skill 和已有的普通用户 Skill', async () => {
    const root = await userRoot();
    await expect(
      stageSkillDraft({
        userDir: root,
        candidateId: 'skill_draft_builtin_creator',
        name: 'otto-skill-creator',
        files: [
          { path: 'SKILL.md', content: skillMarkdown('otto-skill-creator') },
        ],
      }),
    ).rejects.toThrow('内置 Skill');

    const summary = await stageSkillDraft({
      userDir: root,
      candidateId: 'skill_draft_existing_report',
      name: 'existing-report',
      files: [{ path: 'SKILL.md', content: skillMarkdown('existing-report') }],
    });
    const existing = path.join(root, 'skills', 'existing-report');
    await fs.mkdir(existing, { recursive: true });
    await fs.writeFile(
      path.join(existing, 'SKILL.md'),
      skillMarkdown('existing-report'),
    );
    await expect(installConfirmedSkillDraft(root, summary)).rejects.toThrow(
      '必须作为明确的增强候选',
    );
  });

  it('拒绝路径穿越和确认后被篡改的草稿', async () => {
    const root = await userRoot();
    await expect(
      stageSkillDraft({
        userDir: root,
        candidateId: 'skill_draft_path_escape',
        name: 'path-escape',
        files: [
          { path: 'SKILL.md', content: skillMarkdown('path-escape') },
          { path: 'scripts/../../outside.txt', content: 'escape' },
        ],
      }),
    ).rejects.toThrow('越界');

    const summary = await stageSkillDraft({
      userDir: root,
      candidateId: 'skill_draft_tamper_check',
      name: 'tamper-check',
      files: [{ path: 'SKILL.md', content: skillMarkdown('tamper-check') }],
    });
    await fs.appendFile(
      path.join(root, summary.draftRelativePath, 'tamper-check', 'SKILL.md'),
      '\n被修改',
    );
    await expect(installConfirmedSkillDraft(root, summary)).rejects.toThrow(
      '发生变化',
    );

    await expect(
      installConfirmedSkillDraft(root, {
        ...summary,
        draftRelativePath: 'skills/tamper-check',
      }),
    ).rejects.toThrow('个人隔离草稿区');
  });
});
