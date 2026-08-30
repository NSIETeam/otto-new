/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoMemoryEngine } from './autoMerge.js';
import {
  atomicWriteTextFile,
  deduplicateGlobalMemoryContent,
  type AtomicTextWriteOperations,
} from './globalMemoryMaintenance.js';
import { withMemoryFileWriteLock } from './memoryFileLock.js';
import { MemoryTool } from '../tools/memoryTool.js';

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'otto-memory-maintenance-'),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('deduplicateGlobalMemoryContent', () => {
  it('removes only later duplicate facts and preserves user-authored content', () => {
    const input = [
      '# User context',
      '',
      '## Otto Added Memories',
      'This paragraph must survive maintenance.',
      '',
      '### Preferences',
      '- concise replies',
      '<!-- keep this note -->',
      '  - use pnpm  ',
      '- concise replies',
      '---',
      '',
      '## Other Section',
      '- concise replies',
      '',
    ].join('\n');

    const result = deduplicateGlobalMemoryContent(input);

    expect(result).toMatchObject({ before: 3, after: 2, removed: 1 });
    expect(result.content).toBe(
      [
        '# User context',
        '',
        '## Otto Added Memories',
        'This paragraph must survive maintenance.',
        '',
        '### Preferences',
        '- concise replies',
        '<!-- keep this note -->',
        '  - use pnpm  ',
        '---',
        '',
        '## Other Section',
        '- concise replies',
        '',
      ].join('\n'),
    );
  });

  it('preserves CRLF byte-for-byte when there is nothing to change', () => {
    const input =
      '## Otto Added Memories\r\n- first\r\nParagraph\r\n- second\r\n';

    expect(deduplicateGlobalMemoryContent(input)).toEqual({
      content: input,
      before: 2,
      after: 2,
      removed: 0,
    });
  });
});

describe('atomicWriteTextFile', () => {
  it('keeps the original file and removes the temporary file when rename fails', async () => {
    const directory = await makeTemporaryDirectory();
    const destination = path.join(directory, 'global.md');
    await fs.writeFile(destination, 'original', 'utf8');

    const operations: AtomicTextWriteOperations = {
      stat: async (filePath) => fs.stat(filePath),
      open: async (filePath, flags, mode) => {
        const handle = await fs.open(filePath, flags, mode);
        return {
          writeFile: async (data, options) => {
            await handle.writeFile(data, options);
          },
          sync: async () => handle.sync(),
          close: async () => handle.close(),
        };
      },
      rename: async () => {
        throw new Error('simulated rename failure');
      },
      unlink: async (filePath) => fs.unlink(filePath),
      openDirectory: async () => {
        throw new Error('parent directory must not be opened before rename');
      },
    };

    await expect(
      atomicWriteTextFile(destination, 'replacement', operations),
    ).rejects.toThrow('simulated rename failure');

    await expect(fs.readFile(destination, 'utf8')).resolves.toBe('original');
    const names = await fs.readdir(directory);
    expect(names).toEqual(['global.md']);
  });

  it('fails closed when parent-directory fsync fails after replacement', async () => {
    const directory = await makeTemporaryDirectory();
    const destination = path.join(directory, 'global.md');
    await fs.writeFile(destination, 'original', 'utf8');
    let directoryHandleClosed = false;

    const operations: AtomicTextWriteOperations = {
      stat: async (filePath) => fs.stat(filePath),
      open: async (filePath, flags, mode) => {
        const handle = await fs.open(filePath, flags, mode);
        return {
          writeFile: async (data, options) => {
            await handle.writeFile(data, options);
          },
          sync: async () => handle.sync(),
          close: async () => handle.close(),
        };
      },
      rename: async (from, to) => fs.rename(from, to),
      unlink: async (filePath) => fs.unlink(filePath),
      openDirectory: async () => ({
        sync: async () => {
          throw new Error('simulated directory fsync failure');
        },
        close: async () => {
          directoryHandleClosed = true;
        },
      }),
    };

    await expect(
      atomicWriteTextFile(destination, 'replacement', operations),
    ).rejects.toThrow('simulated directory fsync failure');

    expect(directoryHandleClosed).toBe(true);
    await expect(fs.readFile(destination, 'utf8')).resolves.toBe('replacement');
    const names = await fs.readdir(directory);
    expect(names).toEqual(['global.md']);
  });

  it('fails closed when the parent-directory handle cannot be closed', async () => {
    const directory = await makeTemporaryDirectory();
    const destination = path.join(directory, 'global.md');
    await fs.writeFile(destination, 'original', 'utf8');

    const operations: AtomicTextWriteOperations = {
      stat: async (filePath) => fs.stat(filePath),
      open: async (filePath, flags, mode) => {
        const handle = await fs.open(filePath, flags, mode);
        return {
          writeFile: async (data, options) => {
            await handle.writeFile(data, options);
          },
          sync: async () => handle.sync(),
          close: async () => handle.close(),
        };
      },
      rename: async (from, to) => fs.rename(from, to),
      unlink: async (filePath) => fs.unlink(filePath),
      openDirectory: async () => ({
        sync: async () => undefined,
        close: async () => {
          throw new Error('simulated directory close failure');
        },
      }),
    };

    await expect(
      atomicWriteTextFile(destination, 'replacement', operations),
    ).rejects.toThrow('simulated directory close failure');
    await expect(fs.readFile(destination, 'utf8')).resolves.toBe('replacement');
  });

  it('ignores an explicitly unsupported directory-sync error on Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const directory = await makeTemporaryDirectory();
    const destination = path.join(directory, 'global.md');
    await fs.writeFile(destination, 'original', 'utf8');

    const operations: AtomicTextWriteOperations = {
      stat: async (filePath) => fs.stat(filePath),
      open: async (filePath, flags, mode) => {
        const handle = await fs.open(filePath, flags, mode);
        return {
          writeFile: async (data, options) => {
            await handle.writeFile(data, options);
          },
          sync: async () => handle.sync(),
          close: async () => handle.close(),
        };
      },
      rename: async (from, to) => fs.rename(from, to),
      unlink: async (filePath) => fs.unlink(filePath),
      openDirectory: async () => {
        throw Object.assign(new Error('directory sync unsupported'), {
          code: 'EINVAL',
        });
      },
    };

    await expect(
      atomicWriteTextFile(destination, 'replacement', operations),
    ).resolves.toBeUndefined();
    await expect(fs.readFile(destination, 'utf8')).resolves.toBe('replacement');
  });
});

describe('withMemoryFileWriteLock', () => {
  it('releases the queue after a failed operation so the next writer succeeds', async () => {
    const filePath = path.join('memory', 'global.md');
    let firstStarted!: () => void;
    const didStartFirst = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const mayFinishFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondRan = false;

    const first = withMemoryFileWriteLock(filePath, async () => {
      firstStarted();
      await mayFinishFirst;
      throw new Error('simulated first-writer failure');
    });
    await didStartFirst;
    const second = withMemoryFileWriteLock(filePath, async () => {
      secondRan = true;
    });

    expect(secondRan).toBe(false);
    releaseFirst();
    await expect(first).rejects.toThrow('simulated first-writer failure');
    await expect(second).resolves.toBeUndefined();
    expect(secondRan).toBe(true);
  });
});

describe('AutoMemoryEngine global.md maintenance', () => {
  it('serializes maintenance with save_memory so a concurrent fact is not lost', async () => {
    const directory = await makeTemporaryDirectory();
    const globalMdPath = path.join(directory, 'global.md');
    await fs.writeFile(
      globalMdPath,
      '## Otto Added Memories\n- duplicate\n- duplicate\n',
      'utf8',
    );
    const engine = new AutoMemoryEngine({
      storageDir: directory,
      knowledgeDir: directory,
      globalMdPath,
      knowledgeJsonlPath: path.join(directory, 'entries.jsonl'),
    });

    let releaseWrite!: () => void;
    const mayWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted!: () => void;
    const didStartWrite = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });

    const savePromise = MemoryTool.performAddMemoryEntry(
      'new fact',
      globalMdPath,
      {
        readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
        mkdir: (directoryPath, options) => fs.mkdir(directoryPath, options),
        writeFile: async (filePath, content) => {
          writeStarted();
          await mayWrite;
          await atomicWriteTextFile(filePath, content);
        },
      },
    );
    await didStartWrite;

    let maintenanceSettled = false;
    const maintenancePromise = engine.deduplicateGlobalMd().finally(() => {
      maintenanceSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(maintenanceSettled).toBe(false);

    releaseWrite();
    await Promise.all([savePromise, maintenancePromise]);

    await expect(fs.readFile(globalMdPath, 'utf8')).resolves.toBe(
      '## Otto Added Memories\n- duplicate\n- new fact\n',
    );
    const names = await fs.readdir(directory);
    expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
