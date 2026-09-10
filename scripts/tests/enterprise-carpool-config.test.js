/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCarpoolConfig } from '../../packages/server/src/modules/park_carpool/parkCarpoolConfig.ts';

const root = path.resolve('deployment/enterprise-oneclick');
const common = readFileSync(path.join(root, 'lib/common.sh'), 'utf8');
const installer = readFileSync(path.join(root, 'install.sh'), 'utf8');
const upgrade = readFileSync(path.join(root, 'upgrade.sh'), 'utf8');
const example = readFileSync(path.join(root, 'config/enterprise.env.example'), 'utf8');
// Kept explicit so deployment transport can be tested independently of the
// colleague feature branch; the integration audit compares this to its reader.
const keys = ['REQUESTS_ENABLED', 'INVITATIONS_ENABLED', 'GROUPS_ENABLED',
  'PILOT_PARK_IDS', 'MINIMUM_OVERLAP', 'REQUEST_LIMIT_PER_HOUR',
  'COOLDOWN_MINUTES', 'MAX_TAXI_MEMBERS', 'STALE_MINUTES', 'PAUSE_MINUTES',
  'POSITION_RETENTION_HOURS', 'COMMUNICATION_RETENTION_DAYS',
  'DRIVER_MINIMUM_OVERLAP', 'TAXI_MINIMUM_OVERLAP', 'MAXIMUM_DETOUR_SECONDS',
].map(name => `OTTO_PARK_CARPOOL_${name}`);
const flags = ['REQUESTS', 'INVITATIONS', 'GROUPS'].map(name => `OTTO_PARK_CARPOOL_${name}_ENABLED`);
const bash = process.platform === 'win32' ? 'D:/git/bin/bash.exe' : 'bash';
const hasBash = process.platform !== 'win32' || existsSync(bash);
const bashPath = target => target.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);

function run(script, files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'otto-carpool-config-'));
  try {
    for (const [name, value] of Object.entries(files)) writeFileSync(path.join(dir, name), value);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('OTTO_')) delete env[key];
    return spawnSync(bash, ['-c', `set -Eeuo pipefail\n${script}`, 'config-test', bashPath(path.join(root, 'lib/common.sh')), bashPath(dir)], {
      env, encoding: 'utf8', timeout: 10_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('managed carpool configuration transport', () => {
  it('enumerates every actual runtime setting without a wildcard permission', () => {
    const allowlist = common.match(/case "\$key" in([\s\S]*?)\n\s*\*\)/)?.[1] ?? '';
    for (const key of keys) {
      expect(allowlist, key).toContain(key);
      expect(installer, key).toContain(key);
      expect(example, key).toMatch(new RegExp(`^#? ?${key}=`, 'm'));
    }
    expect(allowlist).not.toContain('OTTO_PARK_CARPOOL_*');
  });

  it.runIf(hasBash)('loads a staged pilot literally and continues to reject unknown keys', () => {
    const pilot = flags.map((key, index) => `${key}=${index === 0 ? 'true' : 'false'}`).join('\n');
    const accepted = run('source "$1"\notto_load_config "$2/input.env"\nprintf "%s|%s|%s|%s" "$OTTO_PARK_CARPOOL_REQUESTS_ENABLED" "$OTTO_PARK_CARPOOL_INVITATIONS_ENABLED" "$OTTO_PARK_CARPOOL_GROUPS_ENABLED" "$OTTO_PARK_CARPOOL_PILOT_PARK_IDS"', {
      'input.env': `${pilot}\nOTTO_PARK_CARPOOL_PILOT_PARK_IDS=real-park_1\n`,
    });
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toBe('true|false|false|real-park_1');
    const denied = run('source "$1"\notto_load_config "$2/input.env"', {
      'input.env': 'OTTO_PARK_CARPOOL_BYPASS_AUTH=true\n',
    });
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toContain('OTTO_PARK_CARPOOL_BYPASS_AUTH');
    const literal = run('source "$1"\notto_load_config "$2/input.env"\nprintf "%s" "$OTTO_PARK_CARPOOL_PILOT_PARK_IDS"', {
      'input.env': 'OTTO_PARK_CARPOOL_PILOT_PARK_IDS=$(printf injected)\n',
    });
    expect(literal.status, literal.stderr).toBe(0);
    expect(literal.stdout).toBe('$(printf injected)');
  });

  it.runIf(hasBash)('writes the real installer configuration with closed defaults and no empty pilot', () => {
    const begin = installer.indexOf('write_env() {');
    const end = installer.indexOf('\ninstall -o root', begin);
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    const writer = installer.slice(begin, end);
    const defaults = [...installer.matchAll(/^(OTTO_PARK_CARPOOL_[A-Z_]+=".*")$/gm)].map(match => match[1]).join('\n');
    const result = run(`source "$1"\n${defaults}\nTXN_DIR="$2"\nset +u\n${writer}\ncat "$ENV_TEMP"`);
    expect(result.status, result.stderr).toBe(0);
    for (const key of flags) expect(result.stdout).toContain(`${key}="false"`);
    expect(result.stdout).not.toContain('OTTO_PARK_CARPOOL_PILOT_PARK_IDS=');
    expect(readCarpoolConfig(Object.fromEntries(flags.map(key => [key, 'false'])))).toMatchObject({
      requestsEnabled: false, invitationsEnabled: false, groupsEnabled: false, pilotParkIds: undefined,
    });
    const configured = Object.fromEntries(keys.map(key => [key, key.endsWith('_ENABLED') ? 'true' : key.endsWith('_PILOT_PARK_IDS') ? 'real-park_1,real-park_2' : '1']));
    const config = Object.entries(configured).map(([key, value]) => `${key}=${value}`).join('\n');
    const explicit = run(`source "$1"\notto_load_config "$2/input.env"\n${defaults}\nTXN_DIR="$2"\nset +u\n${writer}\ncat "$ENV_TEMP"`, { 'input.env': config });
    expect(explicit.status, explicit.stderr).toBe(0);
    for (const [key, value] of Object.entries(configured)) expect(explicit.stdout, key).toContain(`${key}="${value}"`);
    const invalid = run(`source "$1"\notto_load_config "$2/input.env"\n${defaults}\nTXN_DIR="$2"\nset +u\n${writer}\ncat "$ENV_TEMP"`, {
      'input.env': 'OTTO_PARK_CARPOOL_REQUESTS_ENABLED=\nOTTO_PARK_CARPOOL_PILOT_PARK_IDS=\n',
    });
    expect(invalid.status, invalid.stderr).toBe(0);
    // Do not silently turn malformed explicit input into a valid closed/default
    // configuration. The existing server parser will reject these empty values.
    expect(invalid.stdout).toContain('OTTO_PARK_CARPOOL_REQUESTS_ENABLED=""');
    expect(invalid.stdout).toContain('OTTO_PARK_CARPOOL_PILOT_PARK_IDS=""');
    const transported = Object.fromEntries([...invalid.stdout.matchAll(/^(OTTO_PARK_CARPOOL_[A-Z_]+)="([^"]*)"$/gm)]
      .map(([, key, value]) => [key, value]));
    for (const key of ['OTTO_PARK_CARPOOL_REQUESTS_ENABLED', 'OTTO_PARK_CARPOOL_PILOT_PARK_IDS'])
      expect(() => readCarpoolConfig({ [key]: transported[key] }), key).toThrow(`${key} 配置无效`);
  });

  it.runIf(hasBash)('collects only present values with Bash 3.2-compatible syntax, retaining explicit empty and literal values', () => {
    const begin = installer.indexOf('CARPOOL_RUNTIME_ENV_ARGS=()');
    const end = installer.indexOf('\nENV_TEMP=', begin);
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    const collect = installer.slice(begin, end);
    expect(collect).not.toMatch(/\[\[\s+-v\s/);
    for (const value of [undefined, '', '0', 'false', '$(printf must-not-execute)']) {
      const assign = value === undefined ? '' : `OTTO_PARK_CARPOOL_PILOT_PARK_IDS='${value}'`;
      const result = run(`${assign}\n${collect}\nprintf '%s' "\${#CARPOOL_RUNTIME_ENV_ARGS[@]}"\nif [ "\${#CARPOOL_RUNTIME_ENV_ARGS[@]}" -gt 0 ]; then printf '|%s|%s' "\${CARPOOL_RUNTIME_ENV_ARGS[0]}" "\${CARPOOL_RUNTIME_ENV_ARGS[1]}"; fi`);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(value === undefined ? '0' : `2|OTTO_PARK_CARPOOL_PILOT_PARK_IDS|${value}`);
    }
  });

  it('preserves configured keys through the actual upgrade transformation and restores the original old-version environment', () => {
    const transform = upgrade.match(/const managedKeys = new Set\(([\s\S]*?)\);\nconst retained =/)[1];
    const managed = new Set([...transform.matchAll(/'([A-Z0-9_]+)'/g)].map(match => match[1]));
    for (const key of keys) expect(managed.has(key), key).toBe(false);
    const body = upgrade.match(/import \{ readFileSync, writeFileSync \} from 'node:fs';\nconst \[source, target, keyPath, bindingPath, appVersion, buildCommit\] =[\s\S]*?(?=\nNODE)/)[0];
    const dir = mkdtempSync(path.join(tmpdir(), 'otto-carpool-upgrade-env-'));
    try {
      const source = path.join(dir, 'before.env');
      const target = path.join(dir, 'next.env');
      const old = 'OTTO_APP_VERSION="1.9.14"\nOTTO_AMAP_WEB_SERVICE_KEY="not-a-real-key"\n';
      const staged = `${old}${flags.map(key => `${key}="false"`).join('\n')}\nOTTO_PARK_CARPOOL_PILOT_PARK_IDS="real-park_1"\n`;
      writeFileSync(source, staged);
      const result = spawnSync(process.execPath, ['--input-type=module', '-', source, target, '/keys/db.key', '/native/binding.node', '1.9.15', 'a'.repeat(40)], {
        input: body, encoding: 'utf8', env: { ...process.env, OTTO_DATABASE_ENCRYPTION_KEY_ID: 'test-key' }, timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      for (const key of [...flags, 'OTTO_PARK_CARPOOL_PILOT_PARK_IDS']) expect(readFileSync(target, 'utf8')).toContain(`${key}=`);
      expect(readFileSync(source, 'utf8')).toBe(staged);
      expect(upgrade).toContain('install -o root -g root -m 0600 "$CONFIG_PATH" "$CONFIG_BACKUP"');
      expect(upgrade).toContain('install -o root -g root -m 0600 "$CONFIG_BACKUP" "$CONFIG_PATH"');
      expect(upgrade).toContain('cp -a "$OLD_DEPLOY_BACKUP"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
