import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(resolve(desktopRoot, path), 'utf8');
const require = createRequire(import.meta.url);

describe('standalone desktop pet entry', () => {
  it('keeps the canvas transparent before JavaScript or lazy CSS has loaded', () => {
    const dom = new JSDOM(read('src/renderer/desktop-pet.html'));
    try {
      const { document, getComputedStyle } = dom.window;
      expect(document.documentElement.dataset.ottoSurface).toBe('desktop-pet');
      expect(document.body.dataset.ottoSurface).toBe('desktop-pet');
      for (const element of [document.documentElement, document.body, document.getElementById('root')]) {
        expect(getComputedStyle(element).backgroundColor).toBe('rgba(0, 0, 0, 0)');
        expect(getComputedStyle(element).overflow).toBe('hidden');
      }
      expect(getComputedStyle(document.documentElement).colorScheme).toBe('light');
    } finally { dom.window.close(); }
  });

  it('ships and loads the transparent entry independently from the main window', () => {
    const config = require('../webpack.config.cjs')({}, { mode: 'production' });
    const entries = config.plugins.filter(plugin => plugin.constructor.name === 'HtmlWebpackPlugin');
    expect(entries.map(plugin => plugin.userOptions.filename)).toEqual(['index.html', 'desktop-pet.html']);
    expect(entries[1].userOptions.template).toBe(resolve(desktopRoot, 'src/renderer/desktop-pet.html'));
    const main = read('src/main/index.ts');
    expect(main).toMatch(/win\.loadFile\(path\.join\(RENDERER_DIR, 'desktop-pet\.html'\)/);
    expect(read('src/renderer/components/DesktopPetSurface.tsx')).toContain("import './DesktopPetSurface.css'");
    expect(read('src/renderer/styles/app.css')).not.toContain('.otto-desktop-pet-surface');
  });
});
