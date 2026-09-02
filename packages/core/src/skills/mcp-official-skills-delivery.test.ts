/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../../../../');

describe('Otto official MCP skills', () => {
  for (const name of ['mcp-finder', 'mcp-creator']) {
    it(`${name} ships as a safe official seed`, () => {
      const markdown = readFileSync(
        resolve(repoRoot, `packages/core/skills-seed/${name}/SKILL.md`),
        'utf8',
      );
      expect(markdown).toContain(`name: ${name}`);
      expect(markdown).toContain('trust=false');
      expect(markdown).toMatch(/不.*自动安装|不能.*立即执行/);
      expect(markdown).toMatch(/加密凭据库|密钥/);
    });
  }

  it('mcp-creator preserves the upstream Apache-2.0 attribution while documenting Otto changes', () => {
    const notice = readFileSync(
      resolve(repoRoot, 'packages/core/skills-seed/mcp-creator/NOTICE.txt'),
      'utf8',
    );
    const license = readFileSync(
      resolve(repoRoot, 'packages/core/skills-seed/mcp-creator/LICENSE.txt'),
      'utf8',
    );

    expect(notice).toContain('Anthropic');
    expect(notice).toContain('mcp-builder');
    expect(notice).toContain('substantially modified for Otto');
    expect(license).toContain('Apache License');
    expect(license).toContain('Version 2.0');
  });
});
