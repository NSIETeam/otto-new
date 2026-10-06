/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const helper = 'deployment/enterprise-oneclick/ci/upload-file.sh';
// Before implementation, execute the actual workflow's old upload function.
// Afterwards, execute its shared helper. Never make real SSH/network calls.
const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8'));
const step = workflow.jobs['deploy-update-mirror'].steps.find((s) =>
  s.run?.includes('upload_file()'),
);
const wrapper = step.run.match(/upload_file\(\) \{[\s\S]*?\n\}/)[0];
const source = existsSync(helper)
  ? `${readFileSync(helper, 'utf8')}\n${wrapper}`
  : wrapper;
const git =
  process.platform === 'win32'
    ? execFileSync('where.exe', ['git'], { encoding: 'utf8' })
        .trim()
        .split(/\r?\n/)[0]
    : null;
const bash = git ? path.resolve(path.dirname(git), '../bin/bash.exe') : 'bash';

function exercise(mode) {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'otto-upload-client-'));
  writeFileSync(path.join(fixture, 'payload'), 'abcdefgh');
  try {
    const result = spawnSync(bash, ['--noprofile', '--norc'], {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        FIXTURE: fixture.replaceAll('\\', '/'),
        MODE: mode,
      },
      input: `set -Eeuo pipefail
cd "$FIXTURE"
digest="$(sha256sum payload | awk '{print $1}')"
empty="$(printf '' | sha256sum | awk '{print $1}')"
fixture_prefix_digest="$(printf abc | sha256sum | awk '{print $1}')"
# Use the same pinned, non-empty SSH options as the real caller. macOS's
# Bash 3.2 treats an empty array as unset under nounset; a mock must not
# invent a transport configuration the release workflow never uses.
SSH_OPTIONS=(-o StrictHostKeyChecking=yes -o BatchMode=yes)
DEPLOY_USER=fixture DEPLOY_HOST=fixture.invalid
MIRROR_TRANSACTION_ID=v1.9.20-1-1
sleep() { :; }
if [ "$MODE" = bsd-stat ]; then
  stat() { printf '%s\\n' 'stat: illegal option -- c' >&2; return 64; }
fi
ssh() {
  local command='' arg
  [ "$1" = -o ] && [ "$2" = StrictHostKeyChecking=yes ] && \
    [ "$3" = -o ] && [ "$4" = BatchMode=yes ] || return 2
  for arg in "$@"; do
    case "$arg" in upload-status|upload-file) command="$arg"; break;; esac
  done
  printf '%s\\n' "$command" >> trace
  if [ "$command" = upload-status ]; then
    [ "$MODE" != status-denied ] || return 2
    local offset=0 prefix_digest="$empty" complete=false
    if [ -f completed ]; then offset=8; prefix_digest="$digest"; complete=true
    elif [ "$MODE" = prefix ] || [ "$MODE" = bad-prefix ]; then offset=3; prefix_digest="$fixture_prefix_digest"; fi
    [ "$MODE" != bad-prefix ] || prefix_digest="$empty"
    [ "$MODE" != source-change ] || printf changed! > payload
    printf 'upload_state kind=mirror transaction=v1.9.20-1-1 role=windows-x64-installer size=8 sha256=%s offset=%s prefix_sha256=%s complete=%s\\n' "$digest" "$offset" "$prefix_digest" "$complete"
    return 0
  fi
  cat > transferred
  [ "$MODE" != always-fails ] || return 255
  if [ "$MODE" = prefix ]; then
    [ "$(cat transferred)" = defgh ] || return 2
  fi
  : > completed
  [ "$MODE" != lost ] || return 255
  [ "$MODE" != wrong-receipt ] || printf '%s\\n' 'untrusted extra output'
  printf 'uploaded kind=mirror transaction=v1.9.20-1-1 role=windows-x64-installer size=8 sha256=%s\\n' "$digest"
}
${source}
if [ "$MODE" = bad-role ]; then
  upload_file 'invalid;not-a-command' payload
else
  upload_file windows-x64-installer payload
fi
printf '%s\\n' client-complete
`,
    });
    return {
      ...result,
      trace: existsSync(path.join(fixture, 'trace'))
        ? readFileSync(path.join(fixture, 'trace'), 'utf8')
            .trim()
            .split(/\r?\n/)
        : [],
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe('bounded, identity-checked SSH upload client', () => {
  it.each(['prefix', 'lost', 'bsd-stat'])(
    'recovers %s without resending accepted bytes',
    (mode) => {
      const result = exercise(mode);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('client-complete\n');
      expect(result.trace.filter((c) => c === 'upload-file')).toHaveLength(1);
      expect(result.trace).toContain('upload-status');
    },
  );
  it('stops after exactly three failed attempts', () => {
    const result = exercise('always-fails');
    expect(result.status).not.toBe(0);
    expect(result.trace.filter((c) => c === 'upload-file')).toHaveLength(3);
  });
  it.each(['bad-prefix', 'status-denied', 'source-change', 'bad-role'])(
    'fails closed before transfer (%s)',
    (mode) => {
      const result = exercise(mode);
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.trace.filter((c) => c === 'upload-file')).toHaveLength(0);
      expect(result.stdout).toBe('');
    },
  );
  it('does not relax exact receipt comparison', () => {
    const result = exercise('wrong-receipt');
    expect(result.status).not.toBe(0);
    expect(result.trace.filter((c) => c === 'upload-file')).toHaveLength(1);
    expect(result.stdout).toBe('');
  });
});
