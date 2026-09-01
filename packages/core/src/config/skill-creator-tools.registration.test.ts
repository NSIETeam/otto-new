/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CreateSkillDraftTool } from '../tools/create-skill-draft.js';
import { ValidateSkillDraftTool } from '../tools/validate-skill-draft.js';

describe('Config Otto Skill Creator tool registration', () => {
  it('把主动草稿与只读验证工具接入 Core 注册表', async () => {
    const source = await readFile(
      fileURLToPath(new URL('./config.ts', import.meta.url)),
      'utf8',
    );

    expect(CreateSkillDraftTool.Name).toBe('create_skill_draft');
    expect(ValidateSkillDraftTool.Name).toBe('validate_skill_draft');
    expect(source).toContain(
      "import { CreateSkillDraftTool } from '../tools/create-skill-draft.js';",
    );
    expect(source).toContain(
      "import { ValidateSkillDraftTool } from '../tools/validate-skill-draft.js';",
    );
    expect(source).toContain('registerCoreTool(CreateSkillDraftTool, this);');
    expect(source).toContain('registerCoreTool(ValidateSkillDraftTool, this);');
  });
});
