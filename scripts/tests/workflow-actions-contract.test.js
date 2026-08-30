import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowsDir = path.resolve(
  import.meta.dirname,
  '../../.github/workflows',
);
const setupPythonV6Sha = 'ece7cb06caefa5fff74198d8649806c4678c61a1';

async function readWorkflows() {
  const workflowNames = (await readdir(workflowsDir)).filter((name) =>
    /\.ya?ml$/.test(name),
  );
  return Promise.all(
    workflowNames.map(async (name) => [
      name,
      await readFile(path.join(workflowsDir, name), 'utf8'),
    ]),
  );
}

describe('GitHub Actions runtime contract', () => {
  it('pins every external action to an immutable commit', async () => {
    const movable = [];
    for (const [name, source] of await readWorkflows()) {
      for (const match of source.matchAll(/uses:\s*([^\s#]+)@([^\s#]+)/g)) {
        if (!/^[0-9a-f]{40}$/.test(match[2])) {
          movable.push(`${name}:${match[1]}@${match[2]}`);
        }
      }
    }
    expect(movable).toEqual([]);
  });

  it('uses the pinned Node 24 based setup-python v6 action', async () => {
    const references = [];
    for (const [name, source] of await readWorkflows()) {
      for (const match of source.matchAll(/actions\/setup-python@([^\s#]+)/g)) {
        references.push(`${name}:${match[1]}`);
      }
    }
    expect(references.length).toBeGreaterThan(0);
    expect(
      references.every((entry) => entry.endsWith(`:${setupPythonV6Sha}`)),
    ).toBe(true);
  });
});
