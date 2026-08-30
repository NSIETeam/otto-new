import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderCodeMap } from '../generate-code-map.mjs';

const rootDir = path.resolve(import.meta.dirname, '../..');

describe('generated Otto code map', () => {
  it('matches the checked-in map', async () => {
    const checkedIn = await readFile(path.join(rootDir, 'docs/code-map.md'), 'utf8');
    expect(checkedIn).toBe(await renderCodeMap());
  });

  it('keeps the critical runtime and release routes visible', async () => {
    const map = await renderCodeMap();
    for (const marker of [
      'Runtime kernel',
      'Enterprise server',
      'Desktop / Electron',
      'Workflow engine',
      'RPA',
      'Customer module path',
      'Versionless macOS Preview path',
      '120 MiB per-DMG gate',
    ]) {
      expect(map).toContain(marker);
    }
  });
});
