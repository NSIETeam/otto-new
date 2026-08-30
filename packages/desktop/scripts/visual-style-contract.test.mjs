/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { readFile, readdir } from 'node:fs/promises';
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
    expect(tokens).toMatch(/:root\[data-otto-theme='light'\]\s*\{[^}]*--otto-sidebar-bg: #f5f5f7;/su);
    expect(tokens).toMatch(/:root\[data-otto-theme='dark'\]\s*\{[^}]*--otto-sidebar-bg: #242426;/su);
    expect(css).toMatch(/\.otto-right-panel\s*\{[^}]*color-scheme: light dark;/su);
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*\.otto-auth-shell\s*\{/su);
    expect(css).toContain('.otto-auth-panel {\n    background: var(--otto-bg);');
    expect(css).toContain('background: color-mix(in srgb, var(--otto-surface) 94%, transparent);');
    expect(css.match(/^\.otto-right-panel\s*\{/gmu)).toHaveLength(1);
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

  it('uses a neutral product accent in both appearance modes', async () => {
    const tokens = await readFile(
      path.join(packageRoot, 'src', 'renderer', 'styles', 'tokens.css'),
      'utf8',
    );

    expect(tokens).toMatch(/:root\s*\{[^}]*--otto-accent: #1d1d1f;/su);
    expect(tokens).toMatch(/:root\[data-otto-theme='dark'\]\s*\{[^}]*--otto-accent: #f5f5f7;/su);
    for (const legacyBlue of ['#007aff', '#0066d6', '#0a84ff', '#409cff']) {
      expect(tokens.toLowerCase()).not.toContain(legacyBlue);
    }
  });

  it('defines every Otto theme variable referenced by production styles', async () => {
    const styles = await Promise.all(
      ['tokens.css', 'app.css', 'module-workspace.css'].map((file) =>
        readFile(path.join(packageRoot, 'src', 'renderer', 'styles', file), 'utf8')),
    );
    const source = styles.join('\n');
    const definitions = new Set(
      [...source.matchAll(/(--otto-[a-z0-9-]+)\s*:/gu)].map((match) => match[1]),
    );
    const references = new Set(
      [...source.matchAll(/var\((--otto-[a-z0-9-]+)/gu)].map((match) => match[1]),
    );

    expect([...references].filter((name) => !definitions.has(name))).toEqual([]);
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
    expect([...css.matchAll(/\.otto-module[^{}]*\{[^}]*#[0-9a-f]{3,8}[^}]*\}/giu)]).toEqual([]);
  });

  it('keeps park service subpages on the neutral right-rail palette', async () => {
    const css = await readFile(
      path.join(packageRoot, 'src', 'renderer', 'styles', 'app.css'),
      'utf8',
    );

    expect(css).toMatch(/\.otto-park-dialog\s*\{[^}]*--otto-accent: var\(--otto-text\);[^}]*--otto-accent-hover: var\(--otto-text\);[^}]*--otto-accent-soft: color-mix\(in srgb, var\(--otto-text\) 10%, transparent\);/su);
    expect(css).toMatch(/\.otto-park-demo__primary\s*\{[^}]*color: var\(--otto-bg\);/su);
    expect(css).not.toMatch(/\.otto-park-(?:demo|toast|survey)[^{]*\{[^}]*(?:#22a06b|#168557)/su);
    expect([...css.matchAll(/\.otto-park[^{}]*\{[^}]*#[0-9a-f]{3,8}[^}]*\}/giu)]).toEqual([]);
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

  it('keeps shared SVG icons theme-derived instead of embedding fixed paint', async () => {
    const icons = await readFile(
      path.join(packageRoot, 'src', 'renderer', 'components', 'icons.tsx'),
      'utf8',
    );

    expect(icons).not.toMatch(/(?:fill|stroke)=["']#[0-9a-f]{3,8}["']/iu);
    expect(icons).toContain("fill: 'none'");
    expect(icons).toContain("stroke: 'currentColor'");
  });

  it('honors the operating-system increased-contrast palette in the right rail', async () => {
    const tokens = await readFile(
      path.join(packageRoot, 'src', 'renderer', 'styles', 'tokens.css'),
      'utf8',
    );

    expect(tokens).toMatch(/@media \(prefers-contrast: more\)\s*\{[^}]*:root\s*\{[^}]*--otto-border: color-mix\(in srgb, var\(--otto-text\) 55%, transparent\);/su);
    expect(tokens).toMatch(/@media \(forced-colors: active\)\s*\{[^}]*:root\s*\{[^}]*--otto-bg: Canvas;/su);
    expect(tokens).toMatch(/\.otto-right-panel\s*\{[^}]*border-left: 1px solid var\(--otto-border-strong\);/su);
  });

  it('keeps Hub subpages free of fixed inline colour themes', async () => {
    const hubDirectory = path.join(packageRoot, 'src', 'renderer', 'components', 'hub');
    const productionFiles = (await readdir(hubDirectory))
      .filter((file) => file.endsWith('.tsx') && !file.includes('.test.'));
    const functionalQrFiles = new Set(['ChannelPairingCard.tsx', 'PrivacyDataPanel.tsx']);

    for (const file of productionFiles) {
      const source = await readFile(path.join(hubDirectory, file), 'utf8');
      const fixedPaint = source.match(/#[0-9a-f]{3,8}/giu) ?? [];
      if (functionalQrFiles.has(file)) {
        expect([...new Set(fixedPaint)].sort()).toEqual(['#111', '#fff']);
      } else {
        expect(fixedPaint, `${file} contains fixed paint`).toEqual([]);
      }
    }

    const css = await readFile(
      path.join(packageRoot, 'src', 'renderer', 'styles', 'app.css'),
      'utf8',
    );
    const fixedHubRules = [...css.matchAll(/\.otto-hub[^{}]*\{[^}]*#[0-9a-f]{3,8}[^}]*\}/giu)]
      .map(([rule]) => rule)
      .filter((rule) => !rule.startsWith('.otto-hub__e2ee-qr'));
    expect(fixedHubRules).toEqual([]);
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

  it('runs visual previews through the same renderer theme synchronization', async () => {
    const preview = await readFile(path.join(packageRoot, 'preview', 'mock.tsx'), 'utf8');
    expect(preview).toContain("import { startRendererThemeSync } from '../src/renderer/themeSync.js';");
    expect(preview).toContain('startRendererThemeSync();');
    expect(preview).toContain("new URLSearchParams(location.search).get('theme')");
  });
});
