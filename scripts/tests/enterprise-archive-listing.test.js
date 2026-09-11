import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { assertPortableArchiveEntries } from '../enterprise-archive-portability.mjs';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const fixtures = [];
afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.mocked(spawnSync).mockClear();
});

function archiveFile(lastName = 'last-file.txt') {
  const prefix = `otto-enterprise-oneclick-v1.9.15-${'a'.repeat(12)}-${'b'.repeat(12)}/release`;
  const names = Array.from({ length: 9000 }, (_, index) => `${prefix}/node_modules/package-${String(index).padStart(5, '0')}/${'x'.repeat(50)}.js`);
  names.push(`${prefix}/${lastName}`);
  const headers = names.map(name => {
    const split = name.lastIndexOf('/');
    const header = Buffer.alloc(512);
    header.write(name.slice(split + 1), 0, 100);
    header.write('0000644\0', 100, 8);
    header.write('00000000000\0', 124, 12);
    header.write('0', 156, 1);
    header.write('ustar\0', 257, 6);
    header.write('00', 263, 2);
    header.write(name.slice(0, split), 345, 155);
    header.fill(32, 148, 156);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    return header;
  });
  const directory = mkdtempSync(path.join(os.tmpdir(), 'otto-archive-listing-'));
  fixtures.push(directory);
  const archivePath = path.join(directory, 'archive with spaces.tar.gz');
  writeFileSync(archivePath, gzipSync(Buffer.concat([...headers, Buffer.alloc(1024)])));
  expect(Buffer.byteLength(names.join('\n'))).toBeGreaterThan(1024 * 1024);
  return { archivePath, names };
}

describe('complete bounded enterprise archive listing', () => {
  it('reads an actual tar listing above the old 1 MiB limit including the final entry', () => {
    const { archivePath, names } = archiveFile();
    expect(assertPortableArchiveEntries(archivePath)).toEqual(names);
    expect(spawnSync).toHaveBeenLastCalledWith('tar', ['-tzf', archivePath], expect.objectContaining({
      maxBuffer: 16 * 1024 * 1024, timeout: 60_000, shell: false, windowsHide: true,
    }));
  }, 15000);

  it.each(['._hidden', '.DS_Store'])('still rejects %s beyond the old capture boundary', last => {
    const { archivePath } = archiveFile(last);
    expect(() => assertPortableArchiveEntries(archivePath)).toThrow(/non-portable entries/);
  }, 15000);

  it.each(['ENOBUFS', 'ETIMEDOUT', 'ENOENT'])('never accepts partial output after %s', code => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: null, error: { code }, stdout: 'safe/file\n', stderr: '' });
    expect(() => assertPortableArchiveEntries('unused.tar.gz')).toThrow(new RegExp(`${code}.*incomplete output rejected`));
  });

  it('rejects a nonzero tar exit even when stdout looks valid', () => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 2, stdout: 'safe/file\n', stderr: 'corrupt archive' });
    expect(() => assertPortableArchiveEntries('unused.tar.gz')).toThrow(/listing failed \(2\)/);
  });

  it.each(['', null, 'safe/file', '\n'])('rejects missing, empty or incomplete output: %s', stdout => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout, stderr: '' });
    expect(() => assertPortableArchiveEntries('unused.tar.gz')).toThrow(/missing|incomplete|empty/);
  });
});
