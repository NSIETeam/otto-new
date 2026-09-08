/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const workflow = readFileSync(
  path.join(repositoryRoot, '.github/workflows/release.yml'),
  'utf8',
).replaceAll('\r\n', '\n');
const settingsSteps = [
  ...workflow.matchAll(
    / {6}- name: (?:Require mutable release settings for latest-pointer compensation|Reconfirm mutable release settings before publication|Reconfirm both release endpoints remain compensatable|Reconfirm mutable release settings before compensation)\r?\n[\s\S]*?(?=\r?\n {6}- name:)/g,
  ),
].map(([step]) => ({
  name: step.split(/\r?\n/)[0].trim(),
  step,
  script: step.split(/ {8}run: \|\r?\n/)[1].replace(/^ {10}/gm, ''),
}));
const gitPath =
  process.platform === 'win32'
    ? execFileSync('where.exe', ['git'], { encoding: 'utf8' })
        .trim()
        .split(/\r?\n/)[0]
    : null;
const bash = gitPath
  ? path.resolve(path.dirname(gitPath), '../bin/bash.exe')
  : 'bash';

function runSettingsStep(script, { waive, canonicalStatus }) {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), 'otto-release-settings-'),
  );
  const callsFile = path.join(directory, 'calls.txt');
  const summaryFile = path.join(directory, 'summary.md');
  try {
    const result = spawnSync(bash, [], {
      input: `
curl() {
  local url="\${@: -1}"
  printf '%s\\n' "$url" >> "$CALLS_FILE"
  case "$url" in
    */NSIETeam/otto-new/actions/permissions) printf '%s' "$CANONICAL_STATUS" ;;
    */NSIETeam/otto-new/immutable-releases) printf '404' ;;
    *) printf '403' ;;
  esac
}
node() { return 0; }
${script}`,
      encoding: 'utf8',
      env: {
        ...process.env,
        ALLOW_UNVERIFIED_LEGACY_MUTABILITY: waive ? 'true' : 'false',
        CANONICAL_ADMIN_TOKEN: 'canonical-fixture',
        LEGACY_ADMIN_TOKEN: '',
        CANONICAL_STATUS: canonicalStatus,
        RELEASES_REPO: 'NSIETeam/otto-new',
        LEGACY_RELEASES_REPO: 'Felix201209/otto-releases',
        DESKTOP_TEST_BUILD: '0',
        CALLS_FILE: callsFile.replaceAll('\\', '/'),
        GITHUB_STEP_SUMMARY: summaryFile.replaceAll('\\', '/'),
      },
    });
    if (result.error) throw result.error;
    return {
      status: result.status,
      calls: existsSync(callsFile) ? readFileSync(callsFile, 'utf8') : '',
      summary: existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : '',
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('explicit legacy administrative verification waiver', () => {
  it('covers all four release/compensation settings gates', () => {
    expect(settingsSteps).toHaveLength(4);
    expect(workflow).toContain('allow_unverified_legacy_mutability:');
  });

  it.each(settingsSteps)(
    'requires legacy verification by default: $name',
    ({ script }) => {
      const result = runSettingsStep(script, {
        waive: false,
        canonicalStatus: '200',
      });
      expect(result.status).not.toBe(0);
      expect(result.summary).not.toContain('unknown');
    },
  );

  it.each(settingsSteps)(
    'records unknown and never queries legacy admin APIs after waiver: $name',
    ({ step, script }) => {
      expect(step).toContain(
        "ALLOW_UNVERIFIED_LEGACY_MUTABILITY: ${{ inputs.allow_unverified_legacy_mutability && 'true' || 'false' }}",
      );
      const result = runSettingsStep(script, {
        waive: true,
        canonicalStatus: '200',
      });
      expect(result.status).toBe(0);
      expect(result.calls).toContain('/NSIETeam/otto-new/immutable-releases');
      expect(result.calls).not.toContain('/Felix201209/otto-releases/');
      expect(result.summary).toContain('mutability: unknown');
      expect(result.summary).toContain(
        'exact latest-pointer compensation is required',
      );
      expect(result.summary).not.toContain('enabled:false');
    },
  );

  it.each(settingsSteps)(
    'cannot waive canonical verification: $name',
    ({ script }) => {
      const result = runSettingsStep(script, {
        waive: true,
        canonicalStatus: '403',
      });
      expect(result.status).not.toBe(0);
      expect(result.summary).toBe('');
    },
  );

  it('keeps publication compensation and server rollback prerequisites independent of the waiver', () => {
    const rollbackJob = workflow.slice(
      workflow.indexOf('\n  rollback-enterprise-release-transaction:'),
    );
    expect(rollbackJob).toContain(
      "needs.rollback-release-publication.result == 'success'",
    );
    expect(rollbackJob).toContain(
      "needs.rollback-update-mirror.result == 'success'",
    );
    expect(rollbackJob).not.toContain('allow_unverified_legacy_mutability');
    expect(workflow).toContain(
      'Legacy repository mutability: unknown. The operator explicitly waived its administrative settings check.',
    );
  });
});
