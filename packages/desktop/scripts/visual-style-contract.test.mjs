/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('desktop visual style contract', () => {
  it('keeps module workspace interactions on shared Otto tokens', async () => {
    const css = await readFile(
      path.join(packageRoot, 'src', 'renderer', 'styles', 'app.css'),
      'utf8',
    );
    const moduleStyles = css.slice(
      css.indexOf('.otto-module-workspace-shell'),
      css.indexOf('.otto-module-workspace__undo'),
    );

    expect(moduleStyles).not.toContain('var(--accent, #1677ff)');
    expect(moduleStyles).not.toContain('var(--line,');
    expect(moduleStyles).not.toContain('var(--text,');
    expect(moduleStyles).toContain('var(--otto-border)');
    expect(moduleStyles).toContain('var(--otto-text)');
  });

  it('gives park surfaces a neutral scoped accent instead of the legacy blue accent', async () => {
    const css = await readFile(
      path.join(packageRoot, 'src', 'renderer', 'styles', 'app.css'),
      'utf8',
    );

    expect(css).toContain('.otto-park-surface-theme');
    expect(css).toContain('--otto-accent: var(--otto-text);');
    expect(css).toContain('--otto-accent-soft: color-mix(in srgb, var(--otto-text) 7%, transparent);');
  });
});
