/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(path.resolve('.github/workflows/release.yml'), 'utf8').replaceAll('\r\n', '\n');
const build = workflow.slice(workflow.indexOf('\n  build:'), workflow.indexOf('\n  verify-windows-signature:'));
const start = build.indexOf('          if [ "$DESKTOP_TEST_BUILD" != "1" ]; then');
const end = build.indexOf('            ENTERPRISE_BASENAME=', start);
const selection = build.slice(start, end).replace(/^ {10}/gm, '');
const bash = process.platform === 'win32' ? 'D:/git/bin/bash.exe' : '/bin/bash';

function selectArchive(names) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'otto-release-shell-'));
  try {
    mkdirSync(path.join(directory, 'deliverables'));
    for (const name of names) writeFileSync(path.join(directory, 'deliverables', name), 'fixture');
    // Native macOS CI uses /bin/bash 3.2. On newer local Bash, disabling these
    // builtins reproduces the missing-command boundary; it is not a full 3.2 VM.
    const script = `set -euo pipefail
enable -n mapfile 2>/dev/null || true
enable -n readarray 2>/dev/null || true
VERSION=1.9.15
DESKTOP_TEST_BUILD=0
${selection}
printf '%s' "$ENTERPRISE_ARCHIVE"
fi
`;
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    return spawnSync(bash, ['--noprofile', '--norc', '-c', script], {
      cwd: directory, env, encoding: 'utf8', timeout: 5000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('macOS release shell compatibility', () => {
  it('does not require Bash 4 builtins in the macOS build job', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(build.match(/^\s*(?:mapfile|readarray|declare -A)\b/m)).toBeNull();
    expect(selection).toContain('-print0');
  });

  it('selects one archive without splitting spaces or unicode', () => {
    const name = 'otto-enterprise-oneclick-v1.9.15-one archive-示例.tar.gz';
    const result = selectArchive([name]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`deliverables/${name}`);
  });

  it.each([
    { kind: 'absent', names: [] },
    { kind: 'ambiguous', names: ['otto-enterprise-oneclick-v1.9.15-a.tar.gz', 'otto-enterprise-oneclick-v1.9.15-b.tar.gz'] },
  ])(
    'rejects $kind enterprise archives', ({ names }) => {
      const result = selectArchive(names);
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
    },
  );
});
