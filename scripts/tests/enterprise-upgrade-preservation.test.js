/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const common = readFileSync(
  path.join(root, 'deployment/enterprise-oneclick/lib/common.sh'),
  'utf8',
).replaceAll('\r\n', '\n');
const upgrade = readFileSync(
  path.join(root, 'deployment/enterprise-oneclick/upgrade.sh'),
  'utf8',
).replaceAll('\r\n', '\n');
const git =
  process.platform === 'win32'
    ? execFileSync('where.exe', ['git'], { encoding: 'utf8' })
        .trim()
        .split(/\r?\n/)[0]
    : null;
const bash = git ? path.resolve(path.dirname(git), '../bin/bash.exe') : 'bash';
const grants =
  'enterprise_tree,park_service,feishu_auto_reply,direct_messages,atoa,knowledge,skill_market';
const keyFiles = [
  'account-sync.key',
  'attachment-storage.key',
  'field-encryption.key',
];

function fixture(run) {
  const directory = realpathSync(mkdtempSync(
    path.join(os.tmpdir(), 'otto-upgrade-preservation-'),
  ));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function shell(directory, script, env = {}) {
  return spawnSync(bash, [], {
    input: `set -Eeuo pipefail\n${common}\ncd -- "$FIXTURE_DIRECTORY"\n${script}`,
    encoding: 'utf8',
    env: {
      ...process.env,
      FIXTURE_DIRECTORY: directory.replaceAll('\\', '/'),
      ...env,
    },
  });
}

describe('existing deployment configuration and key custody', () => {
  it.each([
    { encrypted: false, mode: 'valid', expected: 'plaintext' },
    { encrypted: true, mode: 'valid', expected: 'sqlcipher' },
    { encrypted: true, mode: 'missing-key', expected: null },
    { encrypted: true, mode: 'missing-binding', expected: null },
    { encrypted: true, mode: 'writable-key', expected: null },
    { encrypted: true, mode: 'disabled', expected: null },
  ])(
    'uses the appropriate verifier and fails closed: encrypted=$encrypted, $mode',
    ({ encrypted, mode, expected }) =>
      fixture((directory) => {
        const verifier = readFileSync(
          path.join(root, 'deployment/enterprise-oneclick/verify.sh'),
          'utf8',
        ).replaceAll('\r\n', '\n');
        const start = verifier.indexOf('# Inspect encrypted deployments');
        const end = verifier.indexOf(
          '"$RUNTIME_NODE" "${SCRIPT_DIR}/tools/health-check.mjs"',
          start,
        );
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        writeFileSync(
          path.join(directory, 'data.db'),
          encrypted
            ? Buffer.alloc(32, 9)
            : Buffer.from('SQLite format 3\0fixture'),
        );
        if (mode !== 'missing-key')
          writeFileSync(
            path.join(directory, 'database.key'),
            Buffer.alloc(32, 1),
          );
        if (mode !== 'missing-binding')
          writeFileSync(path.join(directory, 'native.node'), 'fixture-native');
        const result = shell(
          directory,
          `DATA_ROOT="$PWD"
DATA_DB="$PWD/data.db"
CURRENT="$PWD/current"
SCRIPT_DIR="$PWD/tools-parent"
RUNTIME_NODE=fixture_node
OTTO_DATABASE_ENCRYPTION_KEY_FILE="$PWD/database.key"
OTTO_SQLCIPHER_NATIVE_BINDING="$PWD/native.node"
OTTO_DATABASE_ENCRYPTION=${mode === 'disabled' ? 'disabled' : 'required'}
OTTO_DATABASE_ENCRYPTION_KEY_READONLY=${mode === 'writable-key' ? 'false' : 'true'}
fixture_node() {
  case "$1" in
    */db-tool.mjs) test "$2" = inspect; printf plaintext > calls ;;
    */migrate-check.mjs) test "$2" = "$CURRENT"; test "$3" = "$DATA_ROOT"; printf sqlcipher > calls ;;
    *) return 9 ;;
  esac
}
${verifier.slice(start, end)}`,
        );
        if (expected) {
          expect(result.status, result.stderr).toBe(0);
          expect(readFileSync(path.join(directory, 'calls'), 'utf8')).toBe(
            expected,
          );
        } else {
          expect(result.status).not.toBe(0);
          expect(existsSync(path.join(directory, 'calls'))).toBe(false);
        }
      }),
  );

  it('loads seven-feature grants, backup custody, SMS and public URL without shell evaluation', () =>
    fixture((directory) => {
      writeFileSync(
        path.join(directory, 'enterprise.env'),
        [
          `OTTO_ENTERPRISE_DEPLOYMENT_GRANTS="${grants}"`,
          'OTTO_BACKUP_ENCRYPTION_KEY_FILE="/custody/backup.key"',
          'OTTO_DATABASE_ENCRYPTION_KEY_ID="original-key-id"',
          'OTTO_ENTERPRISE_PUBLIC_URL="https://enterprise.example.com:7777"',
          'ALIYUN_SMS_ACCESS_KEY_SECRET="$(touch should-not-exist)"',
          'ALIYUN_SMS_NOTIFICATION_TEMPLATE_ID="notice-template"',
        ].join('\n'),
      );
      const result = shell(
        directory,
        `otto_load_config enterprise.env
test "$OTTO_ENTERPRISE_DEPLOYMENT_GRANTS" = "$EXPECTED_GRANTS"
test "$OTTO_BACKUP_ENCRYPTION_KEY_FILE" = /custody/backup.key
test "$OTTO_DATABASE_ENCRYPTION_KEY_ID" = original-key-id
test "$OTTO_ENTERPRISE_PUBLIC_URL" = https://enterprise.example.com:7777
test "$ALIYUN_SMS_NOTIFICATION_TEMPLATE_ID" = notice-template
test "$ALIYUN_SMS_ACCESS_KEY_SECRET" = '$(touch should-not-exist)'
`,
        { EXPECTED_GRANTS: grants },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(path.join(directory, 'should-not-exist'))).toBe(false);
    }));

  it.each(['NOT_AN_ALLOWED_KEY=fixture-secret', 'malformed-fixture-secret'])(
    'rejects invalid config without printing its secret: %s',
    (line) =>
      fixture((directory) => {
        writeFileSync(path.join(directory, 'enterprise.env'), line);
        const result = shell(directory, 'otto_load_config enterprise.env');
        expect(result.status).not.toBe(0);
        expect(result.stdout + result.stderr).not.toContain('fixture-secret');
      }),
  );

  it('copies the original business keys into the canary and leaves production bytes untouched', () =>
    fixture((directory) => {
      mkdirSync(path.join(directory, 'live'));
      mkdirSync(path.join(directory, 'canary'));
      for (const [index, name] of keyFiles.entries())
        writeFileSync(
          path.join(directory, 'live', name),
          Buffer.alloc(32, index + 1),
        );
      const result = shell(
        directory,
        `otto_prepare_upgrade_canary_keys "$PWD/live" "$PWD/canary"
test "$OTTO_FIELD_ENCRYPTION_KEY_FILE" = "$PWD/canary/field-encryption.key"
test "$OTTO_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE" = "$PWD/canary/account-sync.key"
test "$OTTO_ATTACHMENT_ENCRYPTION_KEY_FILE" = "$PWD/canary/attachment-storage.key"
`,
      );
      expect(result.status, result.stderr).toBe(0);
      for (const [index, name] of keyFiles.entries()) {
        expect(readFileSync(path.join(directory, 'canary', name))).toEqual(
          Buffer.alloc(32, index + 1),
        );
        expect(readFileSync(path.join(directory, 'live', name))).toEqual(
          Buffer.alloc(32, index + 1),
        );
      }
    }));

  it('copies external custody into isolation without changing the external file', () =>
    fixture((directory) => {
      mkdirSync(path.join(directory, 'live'));
      mkdirSync(path.join(directory, 'canary'));
      writeFileSync(path.join(directory, 'external.key'), Buffer.alloc(32, 9));
      const result = shell(
        directory,
        `export OTTO_FIELD_ENCRYPTION_KEY_FILE="$PWD/external.key"
export OTTO_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE="$PWD/external.key"
export OTTO_ATTACHMENT_ENCRYPTION_KEY_FILE="$PWD/external.key"
otto_prepare_upgrade_canary_keys "$PWD/live" "$PWD/canary"`,
      );
      expect(result.status, result.stderr).toBe(0);
      for (const name of keyFiles)
        expect(readFileSync(path.join(directory, 'canary', name))).toEqual(
          Buffer.alloc(32, 9),
        );
      expect(readFileSync(path.join(directory, 'external.key'))).toEqual(
        Buffer.alloc(32, 9),
      );
    }));

  it.each(['missing', 'directory', 'existing-target', 'inside-live'])(
    'fails closed on unsafe canary custody: %s',
    (mode) =>
      fixture((directory) => {
        mkdirSync(path.join(directory, 'live'));
        mkdirSync(path.join(directory, 'canary'));
        if (mode === 'directory')
          mkdirSync(path.join(directory, 'live', keyFiles[0]));
        if (mode === 'existing-target') {
          writeFileSync(
            path.join(directory, 'live', keyFiles[0]),
            Buffer.alloc(32, 1),
          );
          writeFileSync(
            path.join(directory, 'canary', keyFiles[0]),
            'do-not-overwrite',
          );
        }
        const target = mode === 'inside-live' ? 'live' : 'canary';
        const result = shell(
          directory,
          `otto_prepare_upgrade_canary_keys "$PWD/live" "$PWD/${target}"`,
        );
        expect(result.status).not.toBe(0);
        if (mode === 'existing-target')
          expect(
            readFileSync(path.join(directory, 'canary', keyFiles[0]), 'utf8'),
          ).toBe('do-not-overwrite');
      }),
  );

  it('executes the actual cutover writer, preserving policy, custody and all SMS bytes', () =>
    fixture((directory) => {
      const source = path.join(directory, 'enterprise.env');
      const target = path.join(directory, 'enterprise.env.next');
      const retained = [
        '# Original operational policy',
        `OTTO_ENTERPRISE_DEPLOYMENT_GRANTS="${grants}"`,
        'OTTO_BACKUP_ENCRYPTION_KEY_FILE="/custody/original-backup.key"',
        'OTTO_BACKUP_ENCRYPTION_KEY_RECOVERY_FILE="/recovery/backup.key"',
        'OTTO_FIELD_ENCRYPTION_KEY_FILE="/custody/original-field.key"',
        'OTTO_ENTERPRISE_PUBLIC_URL="https://enterprise.example.com:7777"',
        ...[
          'PROVIDER',
          'ACCESS_KEY_ID',
          'ACCESS_KEY_SECRET',
          'SIGN_NAME',
          'TEMPLATE_ID',
          'NOTIFICATION_TEMPLATE_ID',
        ].map((key) => `ALIYUN_SMS_${key}="fixture-${key}"`),
      ];
      writeFileSync(
        source,
        [
          ...retained,
          'OTTO_DATABASE_ENCRYPTION_KEY_ID="old-id"',
          'OTTO_BUILD_COMMIT="old"',
        ].join('\n'),
      );
      const writer = upgrade.match(
        /const \[source, target, keyPath, bindingPath, appVersion, buildCommit\][\s\S]*?(?=\nNODE)/,
      )?.[0];
      expect(writer).toBeTruthy();
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-',
          source,
          target,
          '/custody/database.key',
          '/releases/new/native.node',
          '1.9.15',
          'a'.repeat(40),
        ],
        {
          input: `import { readFileSync, writeFileSync } from 'node:fs';\n${writer}`,
          encoding: 'utf8',
          env: {
            ...process.env,
            OTTO_DATABASE_ENCRYPTION_KEY_ID: 'original-key-id',
            OTTO_FIELD_ENCRYPTION_KEY_FILE: '/temporary/canary/field.key',
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const updated = readFileSync(target, 'utf8');
      for (const line of retained) expect(updated.split('\n')).toContain(line);
      expect(updated).toContain(
        'OTTO_DATABASE_ENCRYPTION_KEY_ID="original-key-id"',
      );
      expect(updated).toContain('OTTO_DATABASE_ENCRYPTION="required"');
      expect(updated).toContain('OTTO_DATABASE_ENCRYPTION_KEY_READONLY="true"');
      expect(updated).not.toContain('/temporary/canary');
      expect(updated).not.toContain('old-id');
      expect(upgrade).toContain(
        'install -o root -g root -m 0600 "$CONFIG_BACKUP" "$CONFIG_PATH"',
      );
    }));

  it('serializes stop, snapshot, migration and task-suppressed canary before cutover', () => {
    const positions = [
      'systemctl stop otto-enterprise\n  GRACEFUL_ACTIVE_STATE=',
      'DATABASE_HEADER=',
      'otto_prepare_upgrade_canary_keys "$DATA_DIR" "$CANARY_DIR"',
      '"${SCRIPT_DIR}/tools/canary-worker.mjs" launch --transaction "$TXN_DIR"',
      '"${SCRIPT_DIR}/tools/canary-worker.mjs" verify-deliverable --transaction "$TXN_DIR"',
      'ROLLBACK_NEEDED=1',
    ].map((marker) => upgrade.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const worker = readFileSync(
      path.join(root, 'deployment/enterprise-oneclick/tools/canary-worker.mjs'),
      'utf8',
    );
    expect(worker).toContain("OTTO_ENTERPRISE_CANARY_MODE: '1'");
    expect(worker).toMatch(
      /'--baseline',\s*`\$\{VIEW\}\/control\/baseline\.json`/,
    );
    expect(worker.indexOf('const migrationResult =')).toBeLessThan(
      worker.indexOf('runtime = startChild('),
    );
  });

  it.each([
    { status: 'active', configured: grants, ok: true },
    { status: 'expiring', configured: grants, ok: true },
    { status: 'grace', configured: grants, ok: true },
    { status: 'expired', configured: grants, ok: false },
    { status: 'invalid', configured: grants, ok: false },
    { status: 'missing', configured: grants, ok: false },
    { status: 'missing', configured: '', ok: true },
  ])(
    'requires a usable signed License for configured grants: $status, granted=$configured',
    ({ status, configured, ok }) => {
      const healthPath = path.join(
        root,
        'deployment/enterprise-oneclick/tools/health-check.mjs',
      );
      const health = readFileSync(healthPath, 'utf8');
      const capabilities = health.match(
        /const requiredCapabilities = ([\s\S]*?);/,
      )?.[1];
      expect(capabilities).toBeTruthy();
      const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
        input: `process.argv = ['node', 'health-check', 'http://127.0.0.1:10000', '1.9.15', '${'a'.repeat(40)}', '26', 'allow-sms-disabled'];
const publicHealth = {status:'ok',service:'otto-enterprise',apiVersion:4,version:'1.9.15',appVersion:'1.9.15',capabilities:${capabilities}};
globalThis.fetch = async (url) => { const body = url.endsWith('/health') ? publicHealth : url.endsWith('/legal') ? [{id:'terms',version:'1',hash:'a'.repeat(64)},{id:'privacy',version:'1',hash:'b'.repeat(64)}] : {runtime:{version:'1.9.15',buildCommit:'a'.repeat(40)},license:{enforce:true,status:${JSON.stringify(status)}},database:{ready:true,schemaVersion:26},operationsSecurity:{sqlCipher:{state:'active'}}}; const response = new Response(JSON.stringify(body)); Object.defineProperty(response, 'url', {value:url}); return response; };
const { main } = await import(${JSON.stringify(pathToFileURL(healthPath).href)}); await main();`,
        encoding: 'utf8',
        env: {
          ...process.env,
          OTTO_ENTERPRISE_DEPLOYMENT_GRANTS: configured,
          OTTO_BUILD_COMMIT: 'a'.repeat(40),
          OTTO_ENTERPRISE_ADMIN_TOKEN: 'fixture-admin-token-not-a-real-secret',
        },
      });
      expect(result.status === 0, result.stderr).toBe(ok);
      if (!ok)
        expect(result.stderr).toContain(
          'require a usable signed deployment License',
        );
    },
  );
});
