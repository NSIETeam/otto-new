/** Test-only fixtures for scripted receipt tests, not business-quality evidence. */
import { afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
export function receiptTestFixture(names: string[]): string {
  const root = mkdtempSync(path.join(tmpdir(), 'otto-semantic-fixture-'));
  roots.push(root);
  const data = path.join(root, 'receipt.json');
  writeFileSync(data, JSON.stringify({ status: 'success' }));
  const file = path.join(root, 'receipt.test.cjs');
  writeFileSync(
    file,
    `const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');\n` +
      names
        .map(
          (name) =>
            `test(${JSON.stringify(name)},()=>assert.equal(JSON.parse(fs.readFileSync(${JSON.stringify(data)},'utf8')).status,'success'));`,
        )
        .join('\n'),
  );
  return file;
}
