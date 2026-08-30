import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowsDir = path.resolve(import.meta.dirname, '../../.github/workflows');

describe('GitHub Actions runtime contract', () => {
  it('does not use the Node 20 based setup-python v5 action', async () => {
    const workflowNames = (await readdir(workflowsDir)).filter((name) => /\.ya?ml$/.test(name));
    const workflows = await Promise.all(
      workflowNames.map(async (name) => [name, await readFile(path.join(workflowsDir, name), 'utf8')]),
    );

    const stale = workflows
      .filter(([, source]) => source.includes('actions/setup-python@v5'))
      .map(([name]) => name);
    expect(stale).toEqual([]);
  });
});
