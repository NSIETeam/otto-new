/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('desktop visual style contract', () => {
  it('keeps the right rail and full-page authentication on the system appearance contract', async () => {
    const [css, tokens] = await Promise.all([
      readFile(path.join(packageRoot, 'src', 'renderer', 'styles', 'app.css'), 'utf8'),
      readFile(path.join(packageRoot, 'src', 'renderer', 'styles', 'tokens.css'), 'utf8'),
    ]);

    expect(tokens).toContain('color-scheme: light dark;');
    expect(css).toMatch(/\.otto-right-panel\s*\{[^}]*color-scheme: light dark;/su);
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*\.otto-auth-shell\s*\{/su);
    expect(css).toContain('.otto-auth-panel {\n    background: var(--otto-bg);');
    expect(css).toContain('background: color-mix(in srgb, var(--otto-surface) 94%, transparent);');
  });

  it('does not leave fixed pale status surfaces in desktop subpages', async () => {
    const css = await readFile(
      path.join(packageRoot, 'src', 'renderer', 'styles', 'app.css'),
      'utf8',
    );

    for (const fixedLightSurface of ['#fff5f3', '#ecfdf5', '#fff5f5', '#fff1f2']) {
      expect(css).not.toContain(fixedLightSurface);
    }
  });

  it('keeps module groups on the shared appearance tokens', async () => {
    const css = await readFile(
      path.join(packageRoot, 'src', 'renderer', 'styles', 'app.css'),
      'utf8',
    );

    expect(css).toMatch(/\.otto-module-group\s*\{[^}]*background: var\(--otto-surface\);/su);
    expect(css).toMatch(/\.otto-module-group__header h2\s*\{[^}]*color: var\(--otto-text\);/su);
    expect(css).toMatch(/\.otto-module-tile\s*\{[^}]*color: var\(--otto-text\);/su);
    expect(css).not.toContain('var(--surface, #fff)');
    expect(css).not.toContain('var(--surface-subtle, #f5f7fa)');
  });

  it('keeps park service subpages on the neutral right-rail palette', async () => {
    const css = await readFile(
      path.join(packageRoot, 'src', 'renderer', 'styles', 'app.css'),
      'utf8',
    );

    expect(css).toMatch(/\.otto-park-dialog\s*\{[^}]*--otto-accent: var\(--otto-text\);[^}]*--otto-accent-hover: var\(--otto-text\);[^}]*--otto-accent-soft: color-mix\(in srgb, var\(--otto-text\) 10%, transparent\);/su);
    expect(css).toMatch(/\.otto-park-demo__primary\s*\{[^}]*color: var\(--otto-bg\);/su);
    expect(css).not.toMatch(/\.otto-park-(?:demo|toast|survey)[^{]*\{[^}]*(?:#22a06b|#168557)/su);
  });

  it('keeps built-in workspace modules on the shared line-icon family', async () => {
    const catalog = await readFile(
      path.join(packageRoot, 'src', 'renderer', 'moduleCatalog.ts'),
      'utf8',
    );

    expect(catalog).toContain("ppt: 'office-presentation'");
    expect(catalog).toContain("meeting: 'office-meeting'");
    expect(catalog).toContain("copy: 'office-copywriting'");
    expect(catalog).not.toContain('if (profile.icon) return `generated:${profile.icon}`');
    expect(catalog).toContain("icon: 'customer-module'");
    expect(catalog).not.toContain("module.iconSrc ? { kind: 'image'");
  });

  it('keeps common navigation and overlay icons in the shared icon registry', async () => {
    const sources = await Promise.all(
      [
        ['src', 'renderer', 'App.tsx'],
        ['src', 'renderer', 'components', 'Sidebar.tsx'],
        ['src', 'renderer', 'components', 'AllConversations.tsx'],
      ].map((segments) => readFile(path.join(packageRoot, ...segments), 'utf8')),
    );

    for (const source of sources) expect(source).not.toContain('<svg');
  });

  it('keeps both browser previews on the desktop React instance for visual audits', async () => {
    const configs = await Promise.all(
      ['webpack.preview.cjs', 'webpack.live.cjs'].map((file) =>
        readFile(path.join(packageRoot, file), 'utf8')),
    );

    for (const config of configs) {
      expect(config).toContain("'react$': require.resolve('react', { paths: [__dirname] })");
      expect(config).toContain("'react-dom$': require.resolve('react-dom', { paths: [__dirname] })");
    }
  });
});
