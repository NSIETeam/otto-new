/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CreateSkillDraftTool } from './create-skill-draft.js';
import { confirmPendingSkill, stageProactiveSkillDraft } from '../orchestration/autoSkillGenerator.js';
import { listSkillReleases } from '../orchestration/skillReleaseEvidence.js';

const roots: string[] = [];
let previousUserDir: string | undefined;

afterEach(async () => {
  if (previousUserDir === undefined) delete process.env['OTTO_USER_DIR'];
  else process.env['OTTO_USER_DIR'] = previousUserDir;
  previousUserDir = undefined;
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('CreateSkillDraftTool', () => {
  it('主动需求只生成待确认草稿，不安装也不执行脚本', async () => {
    previousUserDir = process.env['OTTO_USER_DIR'];
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'otto-create-skill-draft-'),
    );
    roots.push(root);
    process.env['OTTO_USER_DIR'] = root;
    const sentinel = path.join(root, 'executed.txt');
    const tool = new CreateSkillDraftTool();
    const result = await tool.execute(
      {
        name: 'contract-review-flow',
        description:
          '审查合同并输出证据化风险。当用户提出合同审查或条款核对时使用。',
        reason: '用户主动要求把合同审查流程沉淀为可复用 Skill',
        trigger_patterns: ['帮我审查合同', '核对这份合同条款'],
        skill_markdown: [
          '---',
          'name: contract-review-flow',
          'description: 审查合同并输出证据化风险。当用户提出合同审查或条款核对时使用。',
          '---',
          '# 合同审查',
          '',
          '读取合同并逐条标明原文、风险、依据和建议。没有依据时标记待确认，不替代律师判断。',
          '',
          '输出必须保留条款位置，不得编造法律条文或擅自发送合同内容。',
          '',
          '在交付前再次核对合同主体、金额、期限、解除条件和争议解决条款；证据不足的结论必须明确标记为待招聘或法务人员人工复核。',
        ].join('\n'),
        files: [
          {
            path: 'scripts/check.cjs',
            content: `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran');`,
          },
        ],
      },
      new AbortController().signal,
    );

    expect(result.returnDisplay).toContain('尚未安装、未执行');
    expect(result.returnDisplay).toContain('合同审查');
    expect(result.returnDisplay).toContain('业务效果尚未验证');
    await expect(
      fs.access(path.join(root, 'skills', 'contract-review-flow')),
    ).rejects.toThrow();
    await expect(fs.access(sentinel)).rejects.toThrow();
    const pending = JSON.parse(
      await fs.readFile(
        path.join(root, 'memory', 'worklog', 'pending_skills.json'),
        'utf8',
      ),
    ) as Array<{
      id: string;
      source?: string;
      draft?: { risk?: { executionBlocked?: boolean } };
    }>;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      source: 'proactive',
      draft: { risk: { executionBlocked: true } },
    });

    const installedPath = await confirmPendingSkill(pending[0].id);
    expect(installedPath).toBe(
      path.join(root, 'skills', 'contract-review-flow', 'SKILL.md'),
    );
    await expect(
      fs.readFile(
        path.join(root, 'skills', 'contract-review-flow', 'profile.json'),
        'utf8',
      ),
    ).resolves.toContain('auto-skill-contract-review-flow');
    await expect(fs.access(sentinel)).rejects.toThrow();
    const oldProfile = await fs.readFile(path.join(root, 'skills/contract-review-flow/profile.json'), 'utf8');
    expect(oldProfile).not.toContain('自动孵化的专家: contract-review-flow');
    const update = await stageProactiveSkillDraft({ name: 'contract-review-flow', description: '按合同全文整理问题，供法务复核，并说明材料缺口。', reason: '用户要求补充合同缺失材料检查', skillContent: (await fs.readFile(installedPath, 'utf8')).replace('# 合同审查', '# 合同材料核对') });
    expect(update.recommendation).toBe('enhance');
    expect(update.draft?.baseContentHash).toBeTruthy();
    await confirmPendingSkill(update.id);
    const releases = await listSkillReleases(root);
    expect(releases[0].history).toHaveLength(1);
    expect(releases[0].current.function.title).toBe('合同材料核对');
  });
});
