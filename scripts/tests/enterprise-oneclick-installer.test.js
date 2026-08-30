/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const COMMON_SH = path.resolve('deployment/enterprise-oneclick/lib/common.sh');
const INSTALL_SH = path.resolve('deployment/enterprise-oneclick/install.sh');
const EXPORT_MIGRATION_SH = path.resolve(
  'deployment/enterprise-oneclick/export-migration.sh',
);
const DB_TOOL = path.resolve(
  'deployment/enterprise-oneclick/tools/db-tool.mjs',
);
const MIGRATE_CHECK = path.resolve(
  'deployment/enterprise-oneclick/tools/migrate-check.mjs',
);
const HEALTH_CHECK = path.resolve(
  'deployment/enterprise-oneclick/tools/health-check.mjs',
);
const VERIFY_RELEASE = path.resolve(
  'deployment/enterprise-oneclick/tools/verify-release.mjs',
);
const UPGRADE_SH = path.resolve('deployment/enterprise-oneclick/upgrade.sh');
const ENV_EXAMPLE = path.resolve(
  'deployment/enterprise-oneclick/config/enterprise.env.example',
);
const README = path.resolve('deployment/enterprise-oneclick/README.zh-CN.md');
const BUNDLE_SCRIPT = path.resolve('scripts/build-enterprise-oneclick.mjs');
const CI_DEPLOY_GATEWAY = path.resolve(
  'deployment/enterprise-oneclick/ci-deploy-gateway.sh',
);
const CI_DEPLOY_GATEWAY_INSTALLER = path.resolve(
  'deployment/enterprise-oneclick/install-ci-deploy-gateway.sh',
);
const PUBLISH_UPDATE_MIRROR = path.resolve(
  'deployment/enterprise-oneclick/ci/publish-update-mirror.sh',
);
const ROLLBACK_UPDATE_MIRROR = path.resolve(
  'deployment/enterprise-oneclick/ci/rollback-update-mirror.sh',
);
const DEPLOY_SERVER_WORKFLOW = path.resolve(
  '.github/workflows/deploy-server.yml',
);
const RELEASE_WORKFLOW = path.resolve('.github/workflows/release.yml');
const SERVER_DATABASE = path.resolve('packages/server/src/enterprise/db.ts');
const RUNTIME_ENTRY = path.resolve(
  'deployment/enterprise-oneclick/runtime/run.mjs',
);
const SYSTEMD_SERVICE = path.resolve(
  'deployment/enterprise-oneclick/templates/otto-enterprise.service',
);
const SERVER_DATABASE_SOURCE = readFileSync(SERVER_DATABASE, 'utf8');
const ENTERPRISE_SCHEMA_VERSION = Number(
  /export const ENTERPRISE_SCHEMA_VERSION\s*=\s*(\d+)/.exec(
    SERVER_DATABASE_SOURCE,
  )?.[1],
);
if (!Number.isInteger(ENTERPRISE_SCHEMA_VERSION)) {
  throw new Error(
    'unable to resolve ENTERPRISE_SCHEMA_VERSION for release tests',
  );
}
const SUPPORTED_SCHEMA_VERSIONS = Array.from(
  { length: ENTERPRISE_SCHEMA_VERSION - 1 },
  (_, index) => index + 2,
);

function mode(target) {
  return statSync(target).mode & 0o777;
}

function readFirstLine(stream) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(
      () => reject(new Error('fixture server did not start in time')),
      5_000,
    );
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      resolve(buffer.slice(0, newline).trim());
    });
    stream.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

describe('enterprise one-click service layout', () => {
  it.skipIf(process.platform === 'win32')(
    'makes the root-owned runtime and release traversable by the systemd user',
    () => {
      const sandbox = mkdtempSync(path.join(tmpdir(), 'otto-oneclick-layout-'));
      try {
        const installRoot = path.join(sandbox, 'opt', 'otto-enterprise');
        const runtime = path.join(installRoot, 'runtime');
        const nodeBin = path.join(runtime, 'node-v22', 'bin', 'node');
        const releases = path.join(installRoot, 'releases');
        const release = path.join(releases, 'v1.9.0-test');
        const serverEntry = path.join(release, 'src', 'enterprise', 'bin.js');

        mkdirSync(path.dirname(nodeBin), { recursive: true, mode: 0o700 });
        mkdirSync(path.dirname(serverEntry), { recursive: true, mode: 0o700 });
        writeFileSync(nodeBin, '#!/bin/sh\n', { mode: 0o700 });
        writeFileSync(serverEntry, 'export {};\n', { mode: 0o600 });
        for (const target of [
          installRoot,
          runtime,
          path.join(runtime, 'node-v22'),
          path.dirname(nodeBin),
          releases,
          release,
          path.join(release, 'src'),
          path.dirname(serverEntry),
        ]) {
          chmodSync(target, 0o700);
        }

        const result = spawnSync(
          '/bin/bash',
          [
            '-c',
            'source "$1"; shift; otto_prepare_service_layout "$@"',
            'bash',
            COMMON_SH,
            installRoot,
            release,
          ],
          { encoding: 'utf8' },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(mode(installRoot)).toBe(0o755);
        expect(mode(runtime)).toBe(0o755);
        expect(mode(path.join(runtime, 'node-v22', 'bin'))).toBe(0o755);
        expect(mode(nodeBin)).toBe(0o755);
        expect(mode(releases)).toBe(0o755);
        expect(mode(path.dirname(serverEntry))).toBe(0o755);
        expect(mode(serverEntry)).toBe(0o644);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    },
  );

  it('applies the service layout before systemd starts Otto', () => {
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const hardening = installer.indexOf(
      'otto_prepare_service_layout "$INSTALL_ROOT" "$TARGET_RELEASE"',
    );
    const serviceStart = installer.indexOf(
      'systemctl enable --now otto-enterprise',
    );
    expect(hardening).toBeGreaterThan(-1);
    expect(serviceStart).toBeGreaterThan(hardening);
  });

  it('loads License trust only from the signed release and enforces it in production', () => {
    const bundle = readFileSync(BUNDLE_SCRIPT, 'utf8');
    const runtime = readFileSync(RUNTIME_ENTRY, 'utf8');
    const service = readFileSync(SYSTEMD_SERVICE, 'utf8');
    const installer = readFileSync(INSTALL_SH, 'utf8');

    expect(bundle).toContain('OTTO_LICENSE_PUBLIC_KEYS is required');
    expect(bundle).toContain(
      "path.join(releaseRoot, 'license-public-keys.json')",
    );
    expect(runtime).toContain("required('OTTO_LICENSE_TRUST_FILE')");
    expect(runtime).toContain("process.env.OTTO_LICENSE_ENFORCE = 'true'");
    expect(
      runtime.indexOf("await import('./src/enterprise/db.js')"),
    ).toBeGreaterThan(
      runtime.indexOf('OTTO_LICENSE_PUBLIC_KEYS = JSON.stringify'),
    );
    expect(service).toContain('Environment=NODE_ENV=production');
    expect(service).toContain('Environment=OTTO_LICENSE_ENFORCE=true');
    expect(service).toContain('license-public-keys.json');
    expect(installer).toContain('export OTTO_LICENSE_TRUST_FILE=');
  });

  it('keeps the one-click outer stop budget beyond the server drain contract', () => {
    const runtime = readFileSync(RUNTIME_ENTRY, 'utf8');
    const serverSource = readFileSync(
      path.resolve('packages/server/src/enterprise/server.ts'),
      'utf8',
    );
    const service = readFileSync(SYSTEMD_SERVICE, 'utf8');
    const upgrader = readFileSync(UPGRADE_SH, 'utf8');
    expect(runtime).toContain('ENTERPRISE_TASK_DRAIN_TIMEOUT_MS');
    expect(runtime).toContain('const SHUTDOWN_HTTP_GRACE_MS = 15_000');
    expect(runtime).toContain(
      'ENTERPRISE_TASK_DRAIN_TIMEOUT_MS + SHUTDOWN_HTTP_GRACE_MS',
    );
    const forceBody =
      runtime.match(
        /const forceTimer = setTimeout\(\(\) => \{([\s\S]*?)\n\s*\}, FORCE_SHUTDOWN_TIMEOUT_MS\);/u,
      )?.[1] ?? '';
    expect(forceBody).toContain('server.closeAllConnections?.()');
    expect(forceBody).not.toContain('closeEnterpriseDatabase()');
    expect(runtime).not.toContain('}, 15_000);');
    expect(runtime).toContain("shutdown('readiness publication failure', 1)");
    const drainMs = Number(
      /ENTERPRISE_TASK_DRAIN_TIMEOUT_MS\s*=\s*([\d_]+)/u
        .exec(serverSource)?.[1]
        ?.replaceAll('_', ''),
    );
    const httpGraceMs = Number(
      /SHUTDOWN_HTTP_GRACE_MS\s*=\s*([\d_]+)/u
        .exec(runtime)?.[1]
        ?.replaceAll('_', ''),
    );
    const systemdStopMs =
      Number(/^TimeoutStopSec=(\d+)$/mu.exec(service)?.[1]) * 1_000;
    expect(systemdStopMs).toBeGreaterThan(drainMs + httpGraceMs);
    const serviceInstall = upgrader.indexOf(
      'templates/otto-enterprise.service" "$SERVICE_UNIT"',
    );
    expect(serviceInstall).toBeGreaterThan(-1);
    expect(
      upgrader.indexOf('systemctl daemon-reload', serviceInstall),
    ).toBeGreaterThan(serviceInstall);
  });

  it.skipIf(process.platform === 'win32')(
    'handles a real SIGTERM by waiting for server drain before closing SQLite',
    async () => {
      const sandbox = mkdtempSync(path.join(tmpdir(), 'otto-runtime-signal-'));
      const eventFile = path.join(sandbox, 'events.log');
      const trustFile = path.join(sandbox, 'license-public-keys.json');
      const runtimeEntry = path.join(sandbox, 'run.mjs');
      mkdirSync(path.join(sandbox, 'src', 'enterprise'), { recursive: true });
      writeFileSync(path.join(sandbox, 'package.json'), '{"type":"module"}\n');
      writeFileSync(
        trustFile,
        JSON.stringify([
          '-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----\n',
        ]),
      );
      writeFileSync(runtimeEntry, readFileSync(RUNTIME_ENTRY, 'utf8'));
      writeFileSync(
        path.join(sandbox, 'src', 'enterprise', 'db.js'),
        `import fs from 'node:fs';
export function closeEnterpriseDatabase() {
  fs.appendFileSync(process.env.EVENT_FILE, 'db-close\\n');
}
`,
      );
      writeFileSync(
        path.join(sandbox, 'src', 'enterprise', 'server.js'),
        `import fs from 'node:fs';
export const ENTERPRISE_TASK_DRAIN_TIMEOUT_MS = 30_000;
export function startEnterpriseServer() {
  const keepAlive = setInterval(() => {}, 60_000);
  const server = {
    close(callback) {
      clearInterval(keepAlive);
      fs.appendFileSync(process.env.EVENT_FILE, 'close-start\\n');
      setTimeout(() => {
        fs.appendFileSync(process.env.EVENT_FILE, 'close-callback\\n');
        callback();
      }, 250);
      return server;
    },
    closeAllConnections() {
      fs.appendFileSync(process.env.EVENT_FILE, 'forced\\n');
    },
    once() { return server; },
    address() { return { address: '127.0.0.1', port: 17777 }; },
  };
  setImmediate(() => {
    fs.appendFileSync(process.env.EVENT_FILE, 'started\\n');
  });
  return server;
}
`,
      );

      const child = spawn(process.execPath, [runtimeEntry], {
        cwd: sandbox,
        env: {
          ...process.env,
          EVENT_FILE: eventFile,
          OTTO_ENTERPRISE_HOST: '127.0.0.1',
          OTTO_ENTERPRISE_PORT: '17777',
          OTTO_ENTERPRISE_PUBLIC_URL: 'https://otto.example.test',
          OTTO_APP_VERSION: '1.9.14',
          OTTO_BUILD_COMMIT: 'a'.repeat(40),
          OTTO_ENTERPRISE_ADMIN_TOKEN:
            'runtime-signal-admin-token-at-least-32-chars',
          OTTO_ENTERPRISE_TRUST_PROXY_HOPS: '1',
          OTTO_LICENSE_TRUST_FILE: trustFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      try {
        const startedDeadline = Date.now() + 5_000;
        while (
          (!existsSync(eventFile) ||
            !readFileSync(eventFile, 'utf8').includes('started')) &&
          Date.now() < startedDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(readFileSync(eventFile, 'utf8')).toContain('started');
        const signalAt = Date.now();
        expect(child.kill('SIGTERM')).toBe(true);
        const { code, signal } = await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('runtime did not exit after SIGTERM')),
            5_000,
          );
          child.once('exit', (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, signal });
          });
        });
        expect(code, stderr).toBe(0);
        expect(signal).toBeNull();
        expect(Date.now() - signalAt).toBeGreaterThanOrEqual(200);
        expect(readFileSync(eventFile, 'utf8').trim().split('\n')).toEqual([
          'started',
          'close-start',
          'close-callback',
          'db-close',
        ]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
        rmSync(sandbox, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it.skipIf(process.platform === 'win32')(
    'does not close SQLite when readiness failure shutdown reports an in-flight error',
    async () => {
      const sandbox = mkdtempSync(path.join(tmpdir(), 'otto-runtime-ready-'));
      const eventFile = path.join(sandbox, 'events.log');
      const trustFile = path.join(sandbox, 'license-public-keys.json');
      const readinessFile = path.join(sandbox, 'ready.json');
      const runtimeEntry = path.join(sandbox, 'run.mjs');
      mkdirSync(path.join(sandbox, 'src', 'enterprise'), { recursive: true });
      writeFileSync(path.join(sandbox, 'package.json'), '{"type":"module"}\n');
      writeFileSync(
        trustFile,
        JSON.stringify([
          '-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----\n',
        ]),
      );
      writeFileSync(runtimeEntry, readFileSync(RUNTIME_ENTRY, 'utf8'));
      writeFileSync(
        path.join(sandbox, 'src', 'enterprise', 'db.js'),
        `import fs from 'node:fs';
export function closeEnterpriseDatabase() {
  fs.appendFileSync(process.env.EVENT_FILE, 'db-close\\n');
}
`,
      );
      writeFileSync(
        path.join(sandbox, 'src', 'enterprise', 'server.js'),
        `import fs from 'node:fs';
export const ENTERPRISE_TASK_DRAIN_TIMEOUT_MS = 30_000;
export function startEnterpriseServer() {
  fs.appendFileSync(process.env.EVENT_FILE, 'started\\n');
  const server = {
    close(callback) {
      fs.appendFileSync(process.env.EVENT_FILE, 'close-start\\n');
      setTimeout(() => {
        fs.appendFileSync(process.env.EVENT_FILE, 'close-error\\n');
        callback(new Error('completion checkpoint still pending'));
      }, 50);
      return server;
    },
    closeAllConnections() {
      fs.appendFileSync(process.env.EVENT_FILE, 'forced\\n');
    },
    once(event, callback) {
      if (event === 'listening') setImmediate(callback);
      return server;
    },
    address() { return { address: '0.0.0.0', port: 17777 }; },
  };
  return server;
}
`,
      );
      const child = spawn(process.execPath, [runtimeEntry], {
        cwd: sandbox,
        env: {
          ...process.env,
          EVENT_FILE: eventFile,
          OTTO_ENTERPRISE_HOST: '127.0.0.1',
          OTTO_ENTERPRISE_PORT: '17777',
          OTTO_ENTERPRISE_READY_FILE: readinessFile,
          OTTO_ENTERPRISE_PUBLIC_URL: 'https://otto.example.test',
          OTTO_APP_VERSION: '1.9.14',
          OTTO_BUILD_COMMIT: 'b'.repeat(40),
          OTTO_ENTERPRISE_ADMIN_TOKEN:
            'runtime-readiness-admin-token-at-least-32-chars',
          OTTO_ENTERPRISE_TRUST_PROXY_HOPS: '1',
          OTTO_LICENSE_TRUST_FILE: trustFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      try {
        const deadline = Date.now() + 5_000;
        while (
          (!existsSync(eventFile) ||
            !readFileSync(eventFile, 'utf8').includes('close-error')) &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(child.exitCode).toBeNull();
        expect(stderr).toContain('cannot publish canary readiness');
        expect(stderr).toContain('completion checkpoint still pending');
        expect(readFileSync(eventFile, 'utf8').trim().split('\n')).toEqual([
          'started',
          'close-start',
          'close-error',
        ]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
        rmSync(sandbox, { recursive: true, force: true });
      }
    },
    10_000,
  );
});

describe('enterprise one-click schema contract', () => {
  it('verifies redacted public health and authenticated SQLCipher status', async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'otto-health-check-'));
    const database = new DatabaseSync(path.join(sandbox, 'data.db'));
    database.exec(`PRAGMA user_version = ${ENTERPRISE_SCHEMA_VERSION}`);
    database.close();

    const capabilities = [
      'password_auth',
      'sms_registration',
      'personal_enterprise_upgrade',
      'organization_invites',
      'usage_summary',
      'admin_console',
      'direct_messages',
      'atoa',
      'position_invites',
      'park_service_push',
      'park_repair_v1',
      'data_protection_v1',
      'encrypted_attachment_storage_v1',
      'encrypted_message_storage_v1',
      'signed_telemetry_transport_v1',
      'data_governance_v1',
      'privacy_self_service',
    ];
    const adminToken = 'health-check-admin-token-at-least-32-characters';
    const build = 'a'.repeat(40);
    const fixture = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import { createServer } from 'node:http';
          const health = JSON.parse(process.env.HEALTH_FIXTURE);
          const server = createServer((request, response) => {
            response.setHeader('content-type', 'application/json');
            if (request.url === '/enterprise/health') {
              response.end(JSON.stringify(health));
              return;
            }
            if (request.url === '/enterprise/legal') {
              response.end(JSON.stringify({
                documents: [
                  { id: 'privacy', version: '2026-08-30', hash: 'a'.repeat(64) },
                  { id: 'terms', version: '2026-08-30', sha256: 'b'.repeat(64) },
                ],
              }));
              return;
            }
            if (
              request.url === '/enterprise/deployment/status'
              && request.headers['x-otto-admin-token'] === process.env.ADMIN_TOKEN
            ) {
              response.end(JSON.stringify({
                runtime: {
                  version: health.appVersion,
                  buildCommit: process.env.BUILD_COMMIT,
                },
                license: { enforce: true },
                database: {
                  ready: true,
                  schemaVersion: ${ENTERPRISE_SCHEMA_VERSION},
                },
                operationsSecurity: { sqlCipher: { state: 'active' } },
              }));
              return;
            }
            response.statusCode = 401;
            response.end(JSON.stringify({ error: 'unauthorized' }));
          });
          server.listen(0, '127.0.0.1', () => {
            console.log(server.address().port);
          });
        `,
      ],
      {
        env: {
          ...process.env,
          ADMIN_TOKEN: adminToken,
          BUILD_COMMIT: build,
          HEALTH_FIXTURE: JSON.stringify({
            status: 'ok',
            service: 'otto-enterprise',
            apiVersion: 4,
            version: '1.9.14',
            appVersion: '1.9.14',
            capabilities,
          }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    try {
      const port = Number(await readFirstLine(fixture.stdout));
      expect(Number.isInteger(port)).toBe(true);
      const result = spawnSync(
        process.execPath,
        [
          HEALTH_CHECK,
          `http://127.0.0.1:${port}`,
          '1.9.14',
          build,
          String(ENTERPRISE_SCHEMA_VERSION),
          'allow-sms-disabled',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            OTTO_BUILD_COMMIT: build,
            OTTO_ENTERPRISE_ADMIN_TOKEN: adminToken,
            OTTO_ENTERPRISE_DIR: sandbox,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        health: { version: '1.9.14' },
        legalDocuments: [
          { id: 'privacy', version: '2026-08-30' },
          { id: 'terms', version: '2026-08-30' },
        ],
        database: {
          schemaVersion: ENTERPRISE_SCHEMA_VERSION,
          integrity: 'verified-during-migration',
          encryption: 'sqlcipher',
        },
        licenseEnforced: true,
      });
    } finally {
      fixture.kill('SIGTERM');
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 15_000);

  it('derives one enterprise schema contract from the server source and release manifest', () => {
    const bundle = readFileSync(BUNDLE_SCRIPT, 'utf8');
    const serverDatabase = SERVER_DATABASE_SOURCE;
    const databaseTool = readFileSync(DB_TOOL, 'utf8');
    const migrationCheck = readFileSync(MIGRATE_CHECK, 'utf8');
    const healthCheck = readFileSync(HEALTH_CHECK, 'utf8');
    const verifyRelease = readFileSync(VERIFY_RELEASE, 'utf8');
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const upgrader = readFileSync(UPGRADE_SH, 'utf8');
    const exporter = readFileSync(EXPORT_MIGRATION_SH, 'utf8');

    expect(bundle).toContain(
      "const releaseChannel = process.env.OTTO_RELEASE_CHANNEL?.trim() || 'stable'",
    );
    expect(serverDatabase).toContain(
      `export const ENTERPRISE_SCHEMA_VERSION = ${ENTERPRISE_SCHEMA_VERSION}`,
    );
    expect(bundle).toContain('releaseChannel,');
    expect(bundle).toContain(
      'const schemaVersionMatch = /ENTERPRISE_SCHEMA_VERSION',
    );
    expect(bundle).toContain('schemaFrom: supportedSchemaFrom');
    expect(bundle).toContain('schemaTo: schemaVersion');
    expect(bundle).toContain(
      '${buildCommit.slice(0, 12)}-${sourceInputSha256.slice(0, 12)}',
    );
    expect(bundle).toContain("filesBelow(path.join(serverDist, 'src'))");
    expect(bundle).toContain(".filter((relative) => relative.endsWith('.js'))");
    expect(databaseTool).toContain('function expectedSchemaVersion()');
    expect(migrationCheck).toContain('manifest?.database?.schemaTo');
    expect(migrationCheck).toContain(
      'readiness.schemaVersion !== expectedSchemaVersion',
    );
    expect(healthCheck).toContain('publicHealth.apiVersion !== 4');
    expect(migrationCheck).toContain("handle.prepare('PRAGMA quick_check')");
    expect(migrationCheck).toContain(
      "handle.prepare('PRAGMA foreign_key_check')",
    );
    expect(healthCheck).toContain(
      "operationsSecurity?.sqlCipher?.state !== 'active'",
    );
    expect(healthCheck).toContain('/enterprise/deployment/status');
    expect(healthCheck).toContain(
      'deploymentStatus.database?.schemaVersion !== expectedSchema',
    );
    expect(healthCheck).toContain("redirect: 'error'");
    expect(healthCheck).toContain('const exactUrl = expectedUrl ?? url');
    expect(healthCheck).toContain(
      'publicHealth.appVersion !== expectedVersion',
    );
    expect(healthCheck).toContain(
      'expectedUrl: `${baseUrl}/enterprise/deployment/status`',
    );
    expect(healthCheck).toContain('/enterprise/legal');
    expect(healthCheck).toContain("'x-otto-admin-token': adminToken");
    expect(healthCheck).toContain(
      'public health fields are not the exact compatibility contract',
    );
    expect(verifyRelease).toContain('manifest.database.schemaTo - 1');
    expect(verifyRelease).toContain("options.delete('--allow-legacy-lstc')");
    expect(verifyRelease).toContain("? ['stable', 'transition', 'lstc']");
    expect(upgrader).toContain(
      'CURRENT_VERIFY_OPTIONS=(--allow-legacy-lstc --allow-legacy-sqlite)',
    );
    expect(upgrader).toContain(
      'if [ -f "${CURRENT_REAL}/HOTFIX-INFO" ] || [ -f "${CURRENT_REAL}/HOTFIX-PREVIOUS-RELEASE" ]; then',
    );
    expect(upgrader).toContain(
      'CURRENT_VERIFY_OPTIONS+=(--allow-registration-legal-hotfix)',
    );
    expect(upgrader).toContain(
      '"$CURRENT_REAL" "${CURRENT_VERIFY_OPTIONS[@]}"',
    );
    expect(installer).toContain('RELEASE_SCHEMA_TO=');
    expect(installer).toContain('"$IMPORT_SCHEMA" -le "$RELEASE_SCHEMA_TO"');
    expect(exporter).toContain('SCHEMA_TO=');
  });

  it(`accepts v3-v${ENTERPRISE_SCHEMA_VERSION} databases and rejects a future v${ENTERPRISE_SCHEMA_VERSION + 1} database`, () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'otto-oneclick-schema-'));
    try {
      const createDatabase = (schemaVersion) => {
        const target = path.join(sandbox, `schema-${schemaVersion}.db`);
        const database = new DatabaseSync(target);
        database.exec(`
          CREATE TABLE sample (id TEXT PRIMARY KEY);
          INSERT INTO sample (id) VALUES ('preserve-me');
          PRAGMA user_version = ${schemaVersion};
        `);
        database.close();
        return target;
      };

      for (const schemaVersion of SUPPORTED_SCHEMA_VERSIONS.filter(
        (version) => version >= 3,
      )) {
        const inspected = spawnSync(
          process.execPath,
          [DB_TOOL, 'inspect', createDatabase(schemaVersion)],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              OTTO_EXPECTED_SCHEMA_VERSION: String(ENTERPRISE_SCHEMA_VERSION),
            },
          },
        );
        expect(inspected.status, inspected.stderr).toBe(0);
        expect(JSON.parse(inspected.stdout)).toMatchObject({
          userVersion: schemaVersion,
          quickCheck: 'ok',
          foreignKeyCheck: 'ok',
          rowCounts: { sample: 1 },
        });
      }

      const future = spawnSync(
        process.execPath,
        [DB_TOOL, 'inspect', createDatabase(ENTERPRISE_SCHEMA_VERSION + 1)],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            OTTO_EXPECTED_SCHEMA_VERSION: String(ENTERPRISE_SCHEMA_VERSION),
          },
        },
      );
      expect(future.status).toBe(5);
      expect(future.stderr).toContain(
        `高于部署包支持的 ${ENTERPRISE_SCHEMA_VERSION}`,
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 20_000);

  it(`backs up v3 before migration and verifies that v${ENTERPRISE_SCHEMA_VERSION} preserves every row`, () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'otto-oneclick-upgrade-'));
    try {
      const source = path.join(sandbox, 'source-v3.db');
      const backup = path.join(sandbox, 'backup-v3.db');
      const migrated = path.join(
        sandbox,
        `migrated-v${ENTERPRISE_SCHEMA_VERSION}.db`,
      );
      const sourceDatabase = new DatabaseSync(source);
      sourceDatabase.exec(`
        CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO accounts (id, name) VALUES
          ('account-1', '保留账号一'),
          ('account-2', '保留账号二');
        PRAGMA user_version = 3;
      `);
      sourceDatabase.close();

      const backupResult = spawnSync(
        process.execPath,
        [DB_TOOL, 'backup', source, backup],
        { encoding: 'utf8' },
      );
      expect(backupResult.status, backupResult.stderr).toBe(0);
      expect(JSON.parse(backupResult.stdout)).toMatchObject({
        userVersion: 3,
        rowCounts: { accounts: 2 },
      });

      const copyResult = spawnSync(
        process.execPath,
        [DB_TOOL, 'backup', backup, migrated],
        { encoding: 'utf8' },
      );
      expect(copyResult.status, copyResult.stderr).toBe(0);
      const migratedDatabase = new DatabaseSync(migrated);
      migratedDatabase.exec(
        `PRAGMA user_version = ${ENTERPRISE_SCHEMA_VERSION};`,
      );
      migratedDatabase.close();

      const comparison = spawnSync(
        process.execPath,
        [DB_TOOL, 'compare', backup, migrated],
        { encoding: 'utf8' },
      );
      expect(comparison.status, comparison.stderr).toBe(0);
      expect(JSON.parse(comparison.stdout)).toMatchObject({
        before: { userVersion: 3, rowCounts: { accounts: 2 } },
        after: {
          userVersion: ENTERPRISE_SCHEMA_VERSION,
          rowCounts: { accounts: 2 },
        },
        preservedTables: 1,
      });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('rejects a release manifest that omits its channel or has an inconsistent schema range', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'otto-oneclick-manifest-'));
    try {
      const manifest = {
        format: 'otto-enterprise-release-v1',
        version: '1.9.0-test',
        releaseChannel: 'transition',
        buildCommit: '0'.repeat(40),
        buildIdentityKind: 'release-content-sha1',
        sourceCommit: '1'.repeat(40),
        sourceTreeDirty: false,
        sourceDiffSha256:
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        sourceInputSha256: '2'.repeat(64),
        runtime: {
          node: '22.23.1',
          supportedArchitectures: ['linux-x64', 'linux-arm64'],
        },
        database: {
          schemaFrom: SUPPORTED_SCHEMA_VERSIONS,
          schemaTo: ENTERPRISE_SCHEMA_VERSION,
          futureSchemaPolicy: 'reject',
          encryption: 'sqlcipher-required',
          nativeRuntime: 'node',
          nativeRuntimeVersion: '22.23.1',
          nativeTargets: ['linux-x64', 'linux-arm64'],
        },
        files: {},
      };
      const runtimePackage = `${JSON.stringify({ type: 'module', version: manifest.version })}\n`;
      writeFileSync(path.join(sandbox, 'package.json'), runtimePackage);
      manifest.files['package.json'] = createHash('sha256')
        .update(runtimePackage)
        .digest('hex');
      const manifestPath = path.join(sandbox, 'manifest.json');
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

      const valid = spawnSync(process.execPath, [VERIFY_RELEASE, sandbox], {
        encoding: 'utf8',
      });
      expect(valid.status, valid.stderr).toBe(0);
      expect(JSON.parse(valid.stdout)).toMatchObject({
        ok: true,
        releaseChannel: 'transition',
        database: {
          schemaFrom: SUPPORTED_SCHEMA_VERSIONS,
          schemaTo: ENTERPRISE_SCHEMA_VERSION,
          futureSchemaPolicy: 'reject',
        },
      });

      manifest.releaseChannel = 'lstc';
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      const legacyByDefault = spawnSync(
        process.execPath,
        [VERIFY_RELEASE, sandbox],
        { encoding: 'utf8' },
      );
      expect(legacyByDefault.status).toBe(3);
      const legacyUpgrade = spawnSync(
        process.execPath,
        [VERIFY_RELEASE, sandbox, '--allow-legacy-lstc'],
        { encoding: 'utf8' },
      );
      expect(legacyUpgrade.status, legacyUpgrade.stderr).toBe(0);
      expect(JSON.parse(legacyUpgrade.stdout)).toMatchObject({
        ok: true,
        releaseChannel: 'lstc',
      });

      manifest.releaseChannel = 'transition';

      manifest.database.schemaFrom = [2, 3, 4];
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      const stale = spawnSync(process.execPath, [VERIFY_RELEASE, sandbox], {
        encoding: 'utf8',
      });
      expect(stale.status).toBe(3);
      expect(stale.stderr).toContain('manifest.json 格式不正确');

      manifest.database.schemaFrom = SUPPORTED_SCHEMA_VERSIONS;
      delete manifest.releaseChannel;
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      const unmarked = spawnSync(process.execPath, [VERIFY_RELEASE, sandbox], {
        encoding: 'utf8',
      });
      expect(unmarked.status).toBe(3);
      expect(unmarked.stderr).toContain('manifest.json 格式不正确');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('accepts only the audited V1.9.11 registration legal hotfix delta', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'otto-oneclick-hotfix-'));
    try {
      const authDirectory = path.join(sandbox, 'src', 'enterprise');
      mkdirSync(authDirectory, { recursive: true });
      const packageText = `${JSON.stringify({ type: 'module', version: '1.9.11' })}\n`;
      const importMarker = "import * as db from './db.js';\n";
      const responseMarker =
        '            organization: invite ? { id: organization.id, name: organization.name } : null,\n';
      const legalImport =
        "import { CURRENT_LEGAL_DOCUMENTS, legalDocumentHash } from '../modules/data_governance/legalDocuments.js';\n";
      const legalResponse =
        '            legalDocuments: CURRENT_LEGAL_DOCUMENTS.map((document) => ({ id: document.id, version: document.version, hash: legalDocumentHash(document) })),\n';
      const originalAuth = `${importMarker}const invite = null;\nconst organization = { id: 'o', name: 'Otto' };\nconst result = {\n${responseMarker}};\n`;
      const patchedAuth = originalAuth
        .replace(importMarker, importMarker + legalImport)
        .replace(responseMarker, responseMarker + legalResponse);
      const authPath = path.join(authDirectory, 'authRoutes.js');
      writeFileSync(path.join(sandbox, 'package.json'), packageText);
      writeFileSync(authPath, patchedAuth);
      writeFileSync(
        path.join(sandbox, 'HOTFIX-INFO'),
        'registration legal documents response; GitHub Actions run 33029322305\n',
      );
      writeFileSync(
        path.join(sandbox, 'HOTFIX-PREVIOUS-RELEASE'),
        '/opt/otto-enterprise/releases/1.9.11-reviewed\n',
      );
      const hash = (value) => createHash('sha256').update(value).digest('hex');
      const manifest = {
        format: 'otto-enterprise-release-v1',
        version: '1.9.11',
        releaseChannel: 'stable',
        buildCommit: '0'.repeat(40),
        sourceCommit: '1'.repeat(40),
        database: {
          schemaFrom: SUPPORTED_SCHEMA_VERSIONS,
          schemaTo: ENTERPRISE_SCHEMA_VERSION,
          futureSchemaPolicy: 'reject',
          encryption: 'sqlcipher-required',
          nativeRuntime: 'node',
          nativeRuntimeVersion: '22.23.1',
          nativeTargets: ['linux-x64', 'linux-arm64'],
        },
        files: {
          'package.json': hash(packageText),
          'src/enterprise/authRoutes.js': hash(originalAuth),
        },
      };
      writeFileSync(
        path.join(sandbox, 'manifest.json'),
        `${JSON.stringify(manifest)}\n`,
      );

      const strict = spawnSync(process.execPath, [VERIFY_RELEASE, sandbox], {
        encoding: 'utf8',
      });
      expect(strict.status).toBe(3);

      const audited = spawnSync(
        process.execPath,
        [VERIFY_RELEASE, sandbox, '--allow-registration-legal-hotfix'],
        { encoding: 'utf8' },
      );
      expect(audited.status, audited.stderr).toBe(0);

      writeFileSync(authPath, `${patchedAuth}// unrelated mutation\n`);
      const mutated = spawnSync(
        process.execPath,
        [VERIFY_RELEASE, sandbox, '--allow-registration-legal-hotfix'],
        { encoding: 'utf8' },
      );
      expect(mutated.status).toBe(3);
      expect(mutated.stderr).toContain('基线 SHA-256 不匹配');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it(`accepts only a completed v${ENTERPRISE_SCHEMA_VERSION} migration readiness result`, () => {
    const sandbox = mkdtempSync(
      path.join(tmpdir(), 'otto-oneclick-readiness-'),
    );
    try {
      const release = path.join(sandbox, 'release');
      const data = path.join(sandbox, 'data');
      const databaseModule = path.join(release, 'src', 'enterprise', 'db.js');
      mkdirSync(path.dirname(databaseModule), { recursive: true });
      mkdirSync(data, { recursive: true });
      writeFileSync(
        path.join(release, 'package.json'),
        `${JSON.stringify({ type: 'module' })}\n`,
      );
      writeFileSync(
        path.join(release, 'manifest.json'),
        `${JSON.stringify({ database: { schemaTo: ENTERPRISE_SCHEMA_VERSION } })}\n`,
      );
      const writeDatabaseModule = (schemaVersion) => {
        writeFileSync(
          databaseModule,
          [
            `export const getDatabaseReadiness = () => ({ ready: true, schemaVersion: ${schemaVersion} });`,
            `export const getDB = () => ({ prepare(sql) { return { all() { if (sql.includes('quick_check')) return [{ quick_check: 'ok' }]; if (sql.includes('foreign_key_check')) return []; if (sql.includes('sqlite_schema')) return [{ name: 'accounts' }]; return []; }, get() { return { count: 2 }; } }; } });`,
            'export const closeEnterpriseDatabase = () => {};',
            '',
          ].join('\n'),
        );
      };

      writeDatabaseModule(ENTERPRISE_SCHEMA_VERSION);
      const ready = spawnSync(
        process.execPath,
        [MIGRATE_CHECK, release, data],
        { encoding: 'utf8' },
      );
      expect(ready.status, ready.stderr).toBe(0);
      expect(JSON.parse(ready.stdout)).toEqual({
        format: 'otto-enterprise-sqlcipher-inspection-v1',
        ready: true,
        schemaVersion: ENTERPRISE_SCHEMA_VERSION,
        quickCheck: 'ok',
        foreignKeyCheck: 'ok',
        tables: ['accounts'],
        rowCounts: { accounts: 2 },
      });

      writeDatabaseModule(3);
      const stale = spawnSync(
        process.execPath,
        [MIGRATE_CHECK, release, data],
        { encoding: 'utf8' },
      );
      expect(stale.status).toBe(5);
      expect(stale.stderr).toContain('"schemaVersion":3');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('migrates only an isolated copy and compares rows before installing it', () => {
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const stageCopy = installer.indexOf(
      'cp "$MIGRATION_DB" "${CANARY_DIR}/data.db"',
    );
    const rowComparison = installer.indexOf(
      'MIGRATION_CHECK_ARGS+=(--baseline "$IMPORT_INSPECTION")',
    );
    const migration = installer.indexOf('MIGRATED_INFO="$(');
    const finalInstall = installer.indexOf(
      '"${CANARY_DIR}/data.db" "${DATA_DIR}/data.db"',
    );

    expect(stageCopy).toBeGreaterThan(-1);
    expect(rowComparison).toBeGreaterThan(stageCopy);
    expect(migration).toBeGreaterThan(rowComparison);
    expect(finalInstall).toBeGreaterThan(migration);
  });

  it('takes a consistent database snapshot before a formal cutover', () => {
    const upgrader = readFileSync(UPGRADE_SH, 'utf8');
    const stopBeforeSnapshot = upgrader.indexOf(
      'SERVICE_STOPPED=1\n  systemctl stop otto-enterprise',
    );
    const sqliteSnapshot = upgrader.indexOf(
      '"${SCRIPT_DIR}/tools/db-tool.mjs" backup',
    );
    const migration = upgrader.indexOf(
      '"${SCRIPT_DIR}/tools/migrate-check.mjs"',
    );
    const cutover = upgrader.indexOf(
      '"${CANARY_DIR}/data.db" "${DATA_DIR}/data.db"',
    );

    expect(stopBeforeSnapshot).toBeGreaterThan(-1);
    expect(sqliteSnapshot).toBeGreaterThan(stopBeforeSnapshot);
    expect(migration).toBeGreaterThan(sqliteSnapshot);
    expect(cutover).toBeGreaterThan(migration);
    expect(upgrader).toContain(
      'if [ "$SERVICE_STOPPED" -eq 1 ]; then\n      systemctl daemon-reload',
    );
    expect(upgrader).toContain('UPGRADE_SUCCEEDED=1');
  });

  it('restores the exact snapshot and health-checks the old release after a failed cutover', () => {
    const upgrader = readFileSync(UPGRADE_SH, 'utf8');
    const cleanupStart = upgrader.indexOf('cleanup() {');
    const cleanupEnd = upgrader.indexOf('\n}\ntrap cleanup EXIT', cleanupStart);
    const cleanup = upgrader.slice(cleanupStart, cleanupEnd);
    const rollbackArmed = upgrader.indexOf('ROLLBACK_NEEDED=1');
    const replaceLiveData = upgrader.indexOf(
      '"${CANARY_DIR}/data.db" "${DATA_DIR}/data.db"',
    );
    const replaceCurrent = upgrader.indexOf(
      'mv -Tf "${INSTALL_ROOT}/current.next" "${INSTALL_ROOT}/current"',
    );

    expect(rollbackArmed).toBeGreaterThan(-1);
    expect(rollbackArmed).toBeLessThan(replaceLiveData);
    expect(rollbackArmed).toBeLessThan(replaceCurrent);
    expect(cleanup).toContain(
      'install -o otto-enterprise -g otto-enterprise -m 0600',
    );
    expect(cleanup).toContain('"$OLD_DATA_BACKUP" "${DATA_DIR}/data.db"');
    expect(cleanup).toContain(
      'mv -Tf "${INSTALL_ROOT}/current.rollback" "${INSTALL_ROOT}/current"',
    );
    expect(cleanup).toContain(
      'OTTO_ALLOW_SMS_DISABLED="$OTTO_ALLOW_SMS_DISABLED"',
    );
    expect(cleanup).toContain('"${INSTALL_ROOT}/deploy/verify.sh"');
    expect(cleanup).toContain('保留事务证据：${TXN_DIR}');
    expect(cleanup.indexOf('systemctl start otto-enterprise')).toBeLessThan(
      cleanup.indexOf('"${INSTALL_ROOT}/deploy/verify.sh"'),
    );
  });
});

describe('enterprise one-click runtime configuration contract', () => {
  it('accepts every runtime key emitted by the installer during upgrades', () => {
    const common = readFileSync(COMMON_SH, 'utf8');
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const allowlist =
      common.match(/case "\$key" in([\s\S]*?)\n\s*\*\)/)?.[1] ?? '';
    const runtimeEnv =
      installer.match(
        /write_env "\$ENV_TEMP" \\\n([\s\S]*?)\ninstall -o root/,
      )?.[1] ?? '';
    const emittedKeys = [
      ...runtimeEnv.matchAll(/^\s{2}([A-Z][A-Z0-9_]+)\s+/gm),
    ].map((match) => match[1]);

    expect(emittedKeys.length).toBeGreaterThan(30);
    for (const key of emittedKeys) expect(allowlist).toContain(key);
  });

  it('preserves data governance, telemetry and external encryption key settings', () => {
    const envExample = readFileSync(ENV_EXAMPLE, 'utf8');
    const common = readFileSync(COMMON_SH, 'utf8');
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const readme = readFileSync(README, 'utf8');
    const allowlist =
      common.match(/case "\$key" in([\s\S]*?)\n\s*\*\)/)?.[1] ?? '';
    const runtimeEnv =
      installer.match(
        /write_env "\$ENV_TEMP" \\\n([\s\S]*?)\ninstall -o root/,
      )?.[1] ?? '';
    const keys = [
      'OTTO_BACKUP_ENCRYPTION_KEY_RECOVERY_FILE',
      'OTTO_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE',
      'OTTO_ATTACHMENT_ENCRYPTION_KEY_FILE',
      'OTTO_FIELD_ENCRYPTION_KEY_FILE',
      'OTTO_DATABASE_ENCRYPTION_KEY_FILE',
      'OTTO_TELEMETRY_ENDPOINT',
      'OTTO_TELEMETRY_RETENTION_DAYS',
      'OTTO_FEDERATION_ENABLED',
      'OTTO_FEDERATION_GATEWAY_URL',
      'OTTO_FEDERATION_DISPLAY_NAME',
      'OTTO_FEDERATION_POLL_INTERVAL_MS',
      'OTTO_FEDERATION_SIGNING_KEY_FILE',
      'OTTO_DATA_CONTROLLER_NAME',
      'OTTO_PRIVACY_CONTACT',
      'OTTO_LEGAL_DOCUMENTS_APPROVED',
      'OTTO_DATA_REGION',
      'OTTO_DATA_RESIDENCY',
      'OTTO_STORAGE_VOLUME_ENCRYPTED',
      'OTTO_CROSS_BORDER_DATA_ENABLED',
    ];

    for (const key of keys) {
      expect(envExample).toMatch(new RegExp(`^${key}=`, 'm'));
      expect(allowlist).toContain(key);
      expect(runtimeEnv).toContain(`  ${key} `);
      expect(readme).toContain(`\`${key}\``);
    }
  });

  it('updates the deployed runtime identity transactionally during cutover', () => {
    const upgrade = readFileSync(UPGRADE_SH, 'utf8');

    expect(upgrade).toContain('"$RELEASE_VERSION" "$BUILD_ID" <<\'NODE\'');
    expect(upgrade).toContain("'OTTO_APP_VERSION'");
    expect(upgrade).toContain("'OTTO_BUILD_COMMIT'");
    expect(upgrade).toContain("['OTTO_APP_VERSION', appVersion]");
    expect(upgrade).toContain("['OTTO_BUILD_COMMIT', buildCommit]");
    expect(upgrade).toContain('enterprise.env.before');
    expect(upgrade).toContain(
      'install -o root -g root -m 0600 "$CONFIG_BACKUP" "$CONFIG_PATH"',
    );
  });

  it('packages SQLCipher for pinned Node and persists fail-closed key custody', () => {
    const bundle = readFileSync(BUNDLE_SCRIPT, 'utf8');
    const common = readFileSync(COMMON_SH, 'utf8');
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const migrationCheck = readFileSync(MIGRATE_CHECK, 'utf8');

    expect(bundle).toContain('verifySqlCipherNativeAssets(');
    expect(bundle).toContain("'native', 'sqlcipher-node'");
    expect(installer).toContain('export OTTO_DATABASE_ENCRYPTION="required"');
    expect(installer).toContain('database-sqlcipher.key');
    expect(installer).toContain('OTTO_DATABASE_ENCRYPTION_KEY_READONLY "true"');
    expect(installer).toContain(
      'native/sqlcipher/linux-${RUNTIME_ARCH}/better_sqlite3.node',
    );
    expect(common).toContain('OTTO_SQLCIPHER_NATIVE_BINDING');
    expect(migrationCheck).toContain(
      "'otto-enterprise-sqlcipher-inspection-v1'",
    );
    expect(migrationCheck).toContain(
      'migration row-count reconciliation failed',
    );
  });

  it('upgrades plaintext and encrypted databases without overwriting custody', () => {
    const upgrade = readFileSync(UPGRADE_SH, 'utf8');

    expect(upgrade).toContain('export OTTO_DATABASE_ENCRYPTION="required"');
    expect(upgrade).toContain('--snapshot "$OLD_DATA_BACKUP"');
    expect(upgrade).toContain('--baseline "$BASELINE_INSPECTION"');
    expect(upgrade).toContain(
      '"${TARGET_RELEASE}/native/sqlcipher/linux-${RUNTIME_ARCH}/better_sqlite3.node"',
    );
    expect(upgrade).toContain('rm -f "$MANAGED_DATABASE_KEY_PATH"');
    expect(upgrade).toContain('拒绝覆盖');
    const managedKeyBranch = upgrade.indexOf(
      'if [ "$DATABASE_KEY_MANAGED" -eq 1 ]; then',
    );
    const cleanupArmed = upgrade.indexOf(
      'DATABASE_KEY_CREATED=1',
      managedKeyBranch,
    );
    const managedKeyInstall = upgrade.indexOf(
      'install -o root -g otto-enterprise -m 0640',
      managedKeyBranch,
    );
    expect(cleanupArmed).toBeGreaterThan(managedKeyBranch);
    expect(managedKeyInstall).toBeGreaterThan(cleanupArmed);
  });

  it.skipIf(process.platform === 'win32')(
    'removes a newly created managed key when installation fails after creation',
    () => {
      const sandbox = mkdtempSync(path.join(tmpdir(), 'otto-key-cleanup-'));
      const managedKey = path.join(sandbox, 'database-sqlcipher.key');
      try {
        const result = spawnSync(
          'bash',
          [
            '-c',
            `set -Eeuo pipefail
DATABASE_KEY_CREATED=0
MANAGED_DATABASE_KEY_PATH="$1"
cleanup() {
  if [ "$DATABASE_KEY_CREATED" -eq 1 ] && [ -f "$MANAGED_DATABASE_KEY_PATH" ]; then
    rm -f "$MANAGED_DATABASE_KEY_PATH"
  fi
}
trap cleanup EXIT
DATABASE_KEY_CREATED=1
printf 'partial-key' > "$MANAGED_DATABASE_KEY_PATH"
false
`,
            'otto-key-cleanup-test',
            managedKey,
          ],
          { encoding: 'utf8' },
        );
        expect(result.status).not.toBe(0);
        expect(existsSync(managedKey)).toBe(false);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    },
  );
  it('requires independently readable key custody before enabling backup replicas', () => {
    const installer = readFileSync(INSTALL_SH, 'utf8');

    expect(installer).toContain(
      '启用异地备份时必须配置独立的 OTTO_BACKUP_ENCRYPTION_KEY_RECOVERY_FILE',
    );
    expect(installer).toContain('独立备份恢复密钥与当前归档密钥不一致');
    expect(installer).toContain('服务账号无法读取独立备份恢复密钥');
  });
  it('preserves repair notification and Feishu configuration through installation', () => {
    const envExample = readFileSync(ENV_EXAMPLE, 'utf8');
    const common = readFileSync(COMMON_SH, 'utf8');
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const readme = readFileSync(README, 'utf8');
    const allowlist =
      common.match(/case "\$key" in([\s\S]*?)\n\s*\*\)/)?.[1] ?? '';
    const runtimeEnv =
      installer.match(
        /write_env "\$ENV_TEMP" \\\n([\s\S]*?)\ninstall -o root/,
      )?.[1] ?? '';
    const keys = [
      'ALIYUN_SMS_NOTIFICATION_TEMPLATE_ID',
      'OTTO_ENTERPRISE_FEISHU_APP_ID',
      'OTTO_ENTERPRISE_FEISHU_APP_SECRET',
      'OTTO_ENTERPRISE_FEISHU_DOMAIN',
    ];

    for (const key of keys) {
      expect(envExample).toMatch(new RegExp(`^${key}=`, 'm'));
      expect(allowlist).toContain(key);
      expect(runtimeEnv).toContain(`  ${key} "\${${key}:-}"`);
      expect(readme).toContain(`\`${key}\``);
    }
  });
});

describe('enterprise one-click health contract', () => {
  it('lets every upgrade canary bind an isolated loopback port without a reserve race', () => {
    const upgrader = readFileSync(UPGRADE_SH, 'utf8');
    const runtime = readFileSync(RUNTIME_ENTRY, 'utf8');

    expect(upgrader).toContain(
      'CANARY_READY_FILE="${CANARY_DIR}/canary-ready.json"',
    );
    expect(upgrader).toContain('export OTTO_ENTERPRISE_PORT="0"');
    expect(upgrader).toContain(
      'export OTTO_ENTERPRISE_READY_FILE="$CANARY_READY_FILE"',
    );
    expect(upgrader).toContain('export OTTO_ENTERPRISE_CANARY_MODE="1"');
    expect(upgrader).toContain(
      'unset OTTO_ENTERPRISE_CANARY_MODE OTTO_ENTERPRISE_READY_FILE',
    );
    expect(upgrader).toContain('升级 canary 启动后提前退出');
    expect(upgrader).toContain('升级 canary 就绪文件无效');
    expect(upgrader).toContain('"http://127.0.0.1:${CANARY_PORT}"');
    expect(upgrader).not.toContain('server.listen(0, "127.0.0.1"');
    expect(upgrader).not.toContain('OTTO_ENTERPRISE_PORT="17777"');
    expect(runtime).toContain('OTTO_ENTERPRISE_READY_FILE');
    expect(runtime).toContain("server.once('listening'");
    expect(runtime).toContain("flag: 'wx'");
  });

  it('requires upgrade, A2A and park repair capabilities in canary and acceptance docs', () => {
    const healthCheck = readFileSync(HEALTH_CHECK, 'utf8');
    const readme = readFileSync(README, 'utf8');

    for (const capability of [
      'personal_enterprise_upgrade',
      'atoa',
      'park_repair_v1',
      'data_protection_v1',
      'encrypted_attachment_storage_v1',
      'encrypted_message_storage_v1',
      'signed_telemetry_transport_v1',
    ]) {
      expect(healthCheck).toContain(`  '${capability}',`);
      expect(readme).toContain(`\`${capability}\``);
    }
  });
});

describe('enterprise CI deployment gateway contract', () => {
  it('isolates every root script from caller-controlled shell and Python state', () => {
    const gateway = readFileSync(CI_DEPLOY_GATEWAY, 'utf8');
    const installer = readFileSync(CI_DEPLOY_GATEWAY_INSTALLER, 'utf8');
    const publisher = readFileSync(PUBLISH_UPDATE_MIRROR, 'utf8');
    const rollback = readFileSync(ROLLBACK_UPDATE_MIRROR, 'utf8');
    for (const rootScript of [gateway, installer, publisher, rollback]) {
      expect(rootScript.startsWith('#!/bin/bash -p\n')).toBe(true);
      const unsetBlock =
        rootScript.match(/^unset (?:[^\r\n]*\\\r?\n)*[^\r\n]*$/m)?.[0] ?? '';
      const unsetVariables = unsetBlock.split(/[\s\\]+/);
      for (const unsafeVariable of [
        'BASH_ENV',
        'ENV',
        'CDPATH',
        'TMPDIR',
        'PYTHONHOME',
        'PYTHONPATH',
        'OPENSSL_CONF',
        'OPENSSL_MODULES',
        'OPENSSL_ENGINES',
        'TAR_OPTIONS',
        'GZIP',
        'XZ_OPT',
        'BZIP2',
        'NODE_OPTIONS',
        'NODE_PATH',
        'NODE_EXTRA_CA_CERTS',
        'LD_PRELOAD',
        'LD_LIBRARY_PATH',
        'XDG_CONFIG_HOME',
        'XDG_CACHE_HOME',
      ]) {
        expect(unsetVariables).toContain(unsafeVariable);
      }
      expect(rootScript).toContain(
        'readonly PATH=/usr/sbin:/usr/bin:/sbin:/bin',
      );
      expect(rootScript).toContain('export LC_ALL=C');
      expect(rootScript).toContain(
        'export HOME=/root USER=root LOGNAME=root SHELL=/bin/bash',
      );
    }
    for (const unattendedRootScript of [gateway, publisher, rollback]) {
      expect(unattendedRootScript).toContain('cd /');
    }
    expect(
      gateway.match(/\/usr\/bin\/python3 -I -S -/g).length,
    ).toBeGreaterThanOrEqual(5);
    expect(gateway).not.toMatch(/(^|\s)python3\s+-/m);
    expect(gateway).toContain('CLEAN_ENV=(');
    expect(gateway).toContain('/usr/bin/env -i');
    expect(gateway).toContain(
      '"${CLEAN_ENV[@]}" "${PACKAGE_ROOT}/backup-now.sh" "$DEPLOY_CONFIG_PATH"',
    );
    expect(gateway).toContain(
      '"${PACKAGE_ROOT}/${DEPLOY_ACTION}.sh" "${DEPLOY_ARGUMENTS[@]}"',
    );
    expect(gateway).toContain(
      '"${verify_env[@]}" \\\n    OTTO_CONFIG_PATH="$deploy_config_path" \\\n    "${INSTALL_ROOT}/deploy/verify.sh"',
    );
    expect(gateway).toContain(
      'if [ "$COMMAND" = \'verify-deployment\' ]; then',
    );
  });

  it('preflights the root-owned trust anchor, config and fixed helpers through sudo -n', () => {
    const gateway = readFileSync(CI_DEPLOY_GATEWAY, 'utf8');
    const installer = readFileSync(CI_DEPLOY_GATEWAY_INSTALLER, 'utf8');
    const readme = readFileSync(README, 'utf8');
    const preflightStart = gateway.indexOf('if [ "$COMMAND" = \'preflight\' ]');
    const publishStart = gateway.indexOf(
      'if [ "$COMMAND" = \'publish-mirror\' ]',
    );
    const preflight = gateway.slice(preflightStart, publishStart);

    expect(preflightStart).toBeGreaterThan(-1);
    expect(publishStart).toBeGreaterThan(preflightStart);
    expect(gateway).toContain(
      'require_root_owned_regular_file "$GATEWAY_PATH"',
    );
    expect(gateway).toContain(
      'require_root_owned_regular_file "$TRUST_KEY_PATH"',
    );
    expect(gateway).toContain(
      'require_root_owned_regular_file "$CONFIG_PATH_FILE"',
    );
    expect(gateway).toContain(
      'PUBLISH_HELPER_PATH="${LIBEXEC_ROOT}/publish-update-mirror"',
    );
    expect(gateway).toContain(
      'ROLLBACK_HELPER_PATH="${LIBEXEC_ROOT}/rollback-update-mirror"',
    );
    expect(gateway).toContain(
      'require_root_owned_directory_chain "$trusted_directory"',
    );
    expect(gateway).toContain(
      'require_root_owned_regular_file "$PUBLISH_HELPER_PATH"',
    );
    expect(gateway).toContain(
      'require_root_owned_regular_file "$ROLLBACK_HELPER_PATH"',
    );
    expect(preflight).toContain(
      'require_root_owned_regular_file "$DEPLOY_CONFIG_PATH"',
    );
    expect(gateway).toContain(
      'GATEWAY_PROTOCOL="otto-enterprise-ci-deploy-v5"',
    );
    expect(preflight).toContain(
      'GATEWAY_SHA256="$(sha256sum "$GATEWAY_PATH" | awk',
    );
    expect(preflight).toContain(
      'PUBLISH_HELPER_SHA256="$(sha256sum "$PUBLISH_HELPER_PATH" | awk',
    );
    expect(preflight).toContain(
      'ROLLBACK_HELPER_SHA256="$(sha256sum "$ROLLBACK_HELPER_PATH" | awk',
    );
    expect(preflight).toContain(
      "printf 'protocol=%s gateway=%s publish=%s rollback=%s key=%s config=%s deploy_user=%s rollback_user=%s\\n'",
    );
    expect(preflight).toContain(
      '"$ROLLBACK_HELPER_SHA256" "$TRUST_KEY_ID" "$DEPLOY_CONFIG_PATH"',
    );

    for (const installation of [
      'install -o root -g root -m 0700 "$GATEWAY_SOURCE" "$GATEWAY_TEMP"',
      'install -o root -g root -m 0700 "$PUBLISH_SOURCE" "$PUBLISH_TEMP"',
      'install -o root -g root -m 0700 "$ROLLBACK_SOURCE" "$ROLLBACK_TEMP"',
      'install -o root -g root -m 0600 -- "$PUBLIC_KEY" "$TRUST_KEY_TEMP"',
    ]) {
      expect(installer).toContain(installation);
    }
    for (const installation of [
      'atomic_install_fixed_file "$GATEWAY_TEMP" "$GATEWAY_PATH" 0755',
      'atomic_install_fixed_file "$PUBLISH_TEMP" "$PUBLISH_PATH" 0755',
      'atomic_install_fixed_file "$ROLLBACK_TEMP" "$ROLLBACK_PATH" 0755',
      'atomic_install_fixed_file "$TRUST_KEY_TEMP" "$TRUST_KEY_PATH" 0644',
    ]) {
      expect(installer).toContain(installation);
    }
    expect(installer).toContain(
      'require_root_controlled_ancestry "$SCRIPT_DIR"',
    );
    expect(installer).toContain('require_root_controlled_file "$source_file"');
    expect(installer).toContain(
      'PUBLIC_KEY_REAL="$(readlink -f -- "$PUBLIC_KEY")"',
    );
    expect(installer).toContain(
      'require_root_controlled_ancestry "$(dirname -- "$PUBLIC_KEY")"',
    );
    expect(installer).toContain('require_root_controlled_file "$PUBLIC_KEY"');
    expect(installer).toContain(
      '[[ "$DEPLOY_CONFIG_PATH" =~ ^/etc/otto-enterprise/[A-Za-z0-9._-]+\\.env$ ]]',
    );
    expect(installer).toContain(
      'require_root_controlled_ancestry "$(dirname -- "$DEPLOY_CONFIG_PATH")"',
    );
    expect(installer).toContain(
      'require_root_controlled_file "$DEPLOY_CONFIG_PATH"',
    );
    expect(gateway).toContain(
      'require_root_owned_directory_chain "$(dirname -- "$DEPLOY_CONFIG_PATH")"',
    );
    expect(gateway).toContain('[ "$DEPLOY_USER_UID" != "$ROLLBACK_USER_UID" ]');
    expect(gateway).toContain('[ "$DEPLOY_USER_GID" != "$ROLLBACK_USER_GID" ]');
    expect(gateway).toContain('audit_automation_principal "$DEPLOY_USER"');
    expect(gateway).toContain('audit_automation_principal "$ROLLBACK_USER"');
    expect(gateway).toContain('/usr/bin/sudo -n -l -U "$principal"');
    expect(gateway).toContain('[ "$all_groups" = "$primary_group" ]');
    expect(gateway).toContain('[ "${#privilege_rules[@]}" -eq 1 ]');
    expect(
      gateway.indexOf('audit_automation_principal "$ROLLBACK_USER"'),
    ).toBeLessThan(gateway.indexOf('COMMAND="${1:-}"'));
    expect(gateway).toContain('if ! /usr/bin/find "$TRANSACTION_UPLOAD_ROOT"');
    expect(gateway).toContain(
      "fail 'could not enumerate pending upload transactions'",
    );
    expect(installer).toContain('[ "$(stat -c \'%u\' "$directory")" = \'0\' ]');
    expect(gateway).toContain('[ "$(stat -c \'%u\' "$directory")" = \'0\' ]');
    const fixedDirectoryInstall = installer.slice(
      installer.indexOf('install -d -o root -g root -m 0755 \\'),
      installer.indexOf('install -d -o root -g root -m 0711 \\'),
    );
    expect(fixedDirectoryInstall).toContain(
      '/usr/local/sbin "$LIBEXEC_DIR" /etc/sudoers.d',
    );
    expect(fixedDirectoryInstall).not.toContain('/etc/otto-enterprise');
    expect(installer).toContain(
      'atomic_install_fixed_file "$CONFIG_PATH_TEMP" "$CONFIG_PATH_FILE" 0600',
    );
    expect(installer).toContain('runuser -u "$DEPLOY_USER" --');
    expect(installer).toContain('DEPLOY_USER_UID="$(id -u "$DEPLOY_USER")"');
    expect(installer).toContain('DEPLOY_USER_GID="$(id -g "$DEPLOY_USER")"');
    expect(installer).toContain(
      '[ "$DEPLOY_USER_UID" != "$ROLLBACK_USER_UID" ]',
    );
    expect(installer).toContain(
      "|| fail 'deploy and rollback users must have distinct UIDs'",
    );
    expect(installer).toContain(
      '[ "$DEPLOY_USER_GID" != "$ROLLBACK_USER_GID" ]',
    );
    expect(installer).toContain(
      "|| fail 'deploy and rollback users must have distinct primary GIDs'",
    );
    expect(readme).toContain('UID 与主 GID 均不得相同');
    expect(readme).toContain('只比较 SHA-256 fingerprint');
    expect(installer).toContain(
      "|| fail 'deploy user must be an unprivileged non-root account'",
    );
    expect(installer).toContain('sudo -n -l -- "$GATEWAY_PATH" >/dev/null');
    expect(installer).toContain('audit_automation_principal "$DEPLOY_USER"');
    expect(installer).toContain('audit_automation_principal "$ROLLBACK_USER"');
    expect(installer).toContain('sudo -n -l -U "$principal"');
    expect(installer).toContain('[ "$all_groups" = "$primary_group" ]');
    expect(installer).toContain(
      'expected_rule="(root) NOPASSWD: $GATEWAY_PATH"',
    );
    expect(installer).toContain('[ "${#privilege_rules[@]}" -eq 1 ]');
    expect(installer).toContain(
      'STARTING_FIXED_GENERATION="$(snapshot_fixed_generation)"',
    );
    expect(installer).toContain(
      'LOCKED_FIXED_GENERATION="$(snapshot_fixed_generation)"',
    );
    expect(installer).toContain(
      "|| fail 'stale gateway installer observed a different locked trust generation'",
    );
    const lockedGenerationCheck = installer.indexOf(
      '[ "$LOCKED_FIXED_GENERATION" = "$STARTING_FIXED_GENERATION" ]',
    );
    const directorySnapshot = installer.indexOf(
      'for index in "${!DIRECTORY_TARGETS[@]}"; do',
    );
    expect(lockedGenerationCheck).toBeGreaterThan(-1);
    expect(directorySnapshot).toBeGreaterThan(lockedGenerationCheck);
    expect(
      installer.indexOf("DIRECTORY_ROLLBACK_ARMED='true'"),
    ).toBeGreaterThan(directorySnapshot);
    expect(installer).toContain(
      'must never roll back directory state committed',
    );
    expect(installer).toContain(
      "|| fail 'refusing to downgrade the installed gateway protocol'",
    );
    expect(installer).toContain('rm -f -- "$target"');
    expect(installer).toContain(
      '&& /usr/bin/sync -f "$(dirname -- "$target")"',
    );
    expect(installer).toContain(
      'DIRECTORY_METADATA[$index]="$(stat -c \'%u:%g:%a\' "$target")"',
    );
    expect(installer).toContain('rollback_install_directories()');
    expect(installer).toContain('chown "$uid:$gid" "$target"');
    expect(installer).toContain('chmod "$mode" "$target"');
    expect(installer).toContain('rmdir -- "$target"');
    expect(installer).toContain(
      'The fixed lock inode and its root-only hierarchy are permanent',
    );
    expect(installer).not.toContain('rm -f -- "$PRODUCTION_LOCK"');
    expect(installer).not.toContain('exec 9>&-');
  });

  it('durably reconciles and rolls back only a locked one-click upgrade', () => {
    const gateway = readFileSync(CI_DEPLOY_GATEWAY, 'utf8');
    const upgrade = readFileSync(UPGRADE_SH, 'utf8');
    const installer = readFileSync(INSTALL_SH, 'utf8');

    for (const canaryScript of [installer, upgrade]) {
      expect(canaryScript).toContain('export OTTO_ENTERPRISE_CANARY_MODE="1"');
      expect(canaryScript).toContain(
        'unset OTTO_ENTERPRISE_CANARY_MODE OTTO_ENTERPRISE_READY_FILE',
      );
      expect(canaryScript).toContain(
        'CANARY_READY_FILE="${CANARY_DIR}/canary-ready.json"',
      );
    }
    expect(installer).not.toMatch(
      /write_env "\$ENV_TEMP"[\s\S]*?OTTO_ENTERPRISE_CANARY_MODE/,
    );
    expect(upgrade).toContain(
      'OLD_RESIDENT_STATE_BACKUP="${TXN_DIR}/resident-recurring-tasks.json.before"',
    );
    expect(upgrade).toContain(
      'OLD_RESIDENT_STATE_ABSENT="${TXN_DIR}/resident-recurring-tasks.absent"',
    );
    expect(upgrade).toContain(
      '"$OLD_RESIDENT_STATE_BACKUP" "$RESIDENT_STATE_PATH"',
    );
    expect(upgrade).toContain(
      '"$CANARY_RESIDENT_STATE" "$RESIDENT_STATE_PATH"',
    );
    expect(upgrade).toContain(
      'if [ "$preserve_transaction" -eq 0 ] && [ -z "$ROLLBACK_DIR" ]; then',
    );
    expect(upgrade).toContain(
      'install -o root -g root -m 0600 "$CONFIG_BACKUP" "$CONFIG_PATH" \\\n          || rollback_ok=0',
    );
    expect(upgrade).toContain('write_rollback_verified_witness()');
    const oldReleaseVerified = upgrade.indexOf('old_release_verified=1');
    const durableRollbackWitness = upgrade.indexOf(
      'if ! write_rollback_verified_witness; then',
    );
    expect(oldReleaseVerified).toBeGreaterThan(-1);
    expect(durableRollbackWitness).toBeGreaterThan(oldReleaseVerified);
    expect(upgrade).toContain("'OTTO_ENTERPRISE_CANARY_MODE',");
    expect(upgrade).toContain("'OTTO_ENTERPRISE_READY_FILE',");
    expect(upgrade).toContain(
      'DATABASE_KEY_SNAPSHOT="$TXN_DIR/database-key-created"',
    );
    expect(upgrade).toContain(
      'DATABASE_KEY_SNAPSHOT="$TXN_DIR/database-key-preserved"',
    );
    const firstStopArmed = upgrade.indexOf(
      'SERVICE_STOPPED=1\n  systemctl stop otto-enterprise',
    );
    const firstStop = upgrade.indexOf(
      'systemctl stop otto-enterprise',
      firstStopArmed,
    );
    const gracefulState = upgrade.indexOf(
      'GRACEFUL_ACTIVE_STATE="$(systemctl show',
    );
    const snapshotStart = upgrade.indexOf('if [ -e "$RESIDENT_STATE_PATH" ]');
    expect(firstStopArmed).toBeGreaterThan(-1);
    expect(firstStop).toBeGreaterThan(firstStopArmed);
    expect(gracefulState).toBeGreaterThan(firstStop);
    expect(snapshotStart).toBeGreaterThan(gracefulState);
    expect(upgrade).toContain('[ "$GRACEFUL_RESULT" = success ]');
    expect(upgrade).toContain('[ "$GRACEFUL_MAIN_STATUS" = 0 ]');
    const rollbackSync = upgrade.indexOf('/usr/bin/sync -f "$TXN_DIR"');
    const firstLiveDataMutation = upgrade.indexOf(
      '"${CANARY_DIR}/data.db" "${DATA_DIR}/data.db"',
    );
    expect(rollbackSync).toBeGreaterThan(-1);
    expect(firstLiveDataMutation).toBeGreaterThan(rollbackSync);

    expect(gateway).toContain('write_once_durable()');
    expect(gateway).toContain(
      'os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW',
    );
    expect(gateway).toContain(
      'os.link(next_path, final_path, follow_symlinks=False)',
    );
    expect(gateway).toContain('os.fsync(descriptor)');
    expect(gateway).toContain('os.fsync(directory)');
    expect(gateway).toContain('/usr/bin/sync -f "$marker_file"');
    expect(gateway).toContain('if [ "$COMMAND" = \'reconcile-deployment\' ]');
    expect(gateway).toContain(
      'printf \'recovered_%s\\n\' "$DEPLOYMENT_RECEIPT"',
    );
    expect(gateway).toContain('complete_rolled_back_receipt_if_previous()');
    expect(gateway).toContain('printf \'recovered_%s\\n\' "$ROLLBACK_RECEIPT"');
    expect(gateway).not.toContain('find_matching_rolled_back_deployment()');
    expect(gateway).toContain(
      'the exact requested enterprise reconciliation transaction does not exist',
    );
    expect(gateway).toContain('require_complete_upgrade_rollback_snapshot()');
    expect(gateway).toContain(
      'require_complete_upgrade_rollback_snapshot "$transaction_dir"',
    );
    expect(gateway).toContain('rollback-witness.expected');
    expect(gateway).toContain('upgrade/rollback-verified');
    expect(gateway).toContain('database-key-preserved');
    expect(gateway).toContain(
      'automated stable deployment requires an existing one-click current symlink',
    );
    expect(gateway).not.toContain("DEPLOY_ACTION='install'");

    const stagedState = gateway.indexOf(
      'DEPLOYMENT_STATE_STAGING="${STAGING_DIR}/deployment-state"',
    );
    const durableState = gateway.indexOf(
      'write_once_durable "$STATE_FILE" "$STATE_CONTENT"',
      stagedState,
    );
    const publishState = gateway.indexOf(
      'mv -- "$DEPLOYMENT_STATE_STAGING" "$DEPLOYMENT_STATE_DIR"',
      durableState,
    );
    const runUpgrade = gateway.indexOf(
      '"${PACKAGE_ROOT}/${DEPLOY_ACTION}.sh" "${DEPLOY_ARGUMENTS[@]}"',
      publishState,
    );
    expect(stagedState).toBeGreaterThan(-1);
    expect(durableState).toBeGreaterThan(stagedState);
    expect(publishState).toBeGreaterThan(durableState);
    expect(runUpgrade).toBeGreaterThan(publishState);
    expect(gateway).not.toContain('} > "$STATE_FILE"');

    const finalizeMarker = gateway.indexOf(
      'write_once_durable "${DEPLOYMENT_STATE_DIR}/finalized"',
    );
    const finalizeGarbageCollection = gateway.indexOf(
      'rm -rf --one-file-system -- "${DEPLOYMENT_STATE_DIR}/upgrade"',
      finalizeMarker,
    );
    expect(finalizeMarker).toBeGreaterThan(-1);
    expect(finalizeGarbageCollection).toBeGreaterThan(finalizeMarker);
    const finalizeStart = gateway.indexOf(
      'if [ "$COMMAND" = \'finalize-deployment\' ]; then',
    );
    const finalizedRetry = gateway.indexOf(
      'if [ -e "${DEPLOYMENT_STATE_DIR}/finalized" ]',
      finalizeStart,
    );
    const firstFinalizeSnapshotRequirement = gateway.indexOf(
      'complete_deployment_receipt "$DEPLOYMENT_STATE_DIR"',
      finalizeStart,
    );
    expect(finalizedRetry).toBeGreaterThan(finalizeStart);
    expect(firstFinalizeSnapshotRequirement).toBeGreaterThan(finalizedRetry);

    const rollbackStart = gateway.indexOf(
      'if [ "$COMMAND" = \'rollback-enterprise\' ]; then',
    );
    const rollbackStaticCheck = gateway.indexOf(
      'enterprise rollback is missing resident task state snapshot identity',
      rollbackStart,
    );
    const rollbackStop = gateway.indexOf(
      'systemctl stop otto-enterprise',
      rollbackStart,
    );
    const rollbackMarker = gateway.indexOf(
      'write_once_durable "${DEPLOYMENT_STATE_DIR}/rolled-back"',
      rollbackStop,
    );
    expect(rollbackStaticCheck).toBeGreaterThan(rollbackStart);
    expect(rollbackStop).toBeGreaterThan(rollbackStaticCheck);
    expect(rollbackMarker).toBeGreaterThan(rollbackStop);
    expect(gateway).toContain(
      '/var/lib/otto-enterprise/resident-recurring-tasks.json',
    );
  });

  it('uses one fixed root-only bootstrap temp directory independent of TMPDIR', () => {
    const installer = readFileSync(CI_DEPLOY_GATEWAY_INSTALLER, 'utf8');

    expect(installer).toMatch(/unset[\s\S]*?\bTMPDIR\b/);
    expect(installer).toContain(
      'BOOTSTRAP_TEMP_DIR="$(mktemp -d /var/tmp/otto-ci-gateway-bootstrap.XXXXXXXX)"',
    );
    expect(installer).toContain(
      '[ "$(stat -c \'%u:%g:%a\' "$BOOTSTRAP_TEMP_DIR")" = \'0:0:700\' ]',
    );
    expect(installer).toContain(
      'TRUST_KEY_TEMP="${BOOTSTRAP_TEMP_DIR}/trusted-public.pem"',
    );
    expect(installer).toContain('GATEWAY_TEMP="${BOOTSTRAP_TEMP_DIR}/gateway"');
    expect(installer).toContain('trap installer_exit EXIT');
    expect(installer).toContain('rm -rf -- "$BOOTSTRAP_TEMP_DIR"');
    expect(installer).not.toMatch(
      /\bmktemp\b(?! -d \/var\/tmp\/otto-ci-gateway-bootstrap\.XXXXXXXX)/,
    );
  });

  it('documents an independently trusted, bounded, and self-cleaning first bootstrap', () => {
    const readme = readFileSync(README, 'utf8');
    expect(readme).toContain(
      "SHELL=/usr/bin/bash /usr/bin/bash -p <<'ROOT_BOOTSTRAP'",
    );
    expect(readme).toContain('TRUSTED_PYTHON=/usr/bin/python3.12');
    expect(readme).toContain('TRUSTED_OPENSSL=/usr/bin/openssl');
    expect(readme).toContain('"$TRUSTED_PYTHON" -I -S - \\');
    expect(readme).not.toContain('/usr/bin/node "$TRUSTED_VERIFIER"');
    expect(readme).toContain('require_root_controlled_path()');
    expect(readme).toContain(
      '[ "$(readlink -f -- "$trusted_path")" = "$trusted_path" ]',
    );
    expect(readme).toContain(
      'for trusted_file in "$TRUSTED_PUBLIC_KEY" "$TRUSTED_PYTHON" "$TRUSTED_OPENSSL"; do',
    );
    expect(readme).toContain(
      'BOOTSTRAP_DIR="$(mktemp -d /var/tmp/otto-ci-gateway-bootstrap.XXXXXXXX)"',
    );
    expect(readme).toContain(
      '[ "$(stat -c \'%u:%g:%a\' -- "$BOOTSTRAP_DIR")" = \'0:0:700\' ]',
    );
    expect(readme).toContain('trap cleanup_bootstrap EXIT');
    expect(readme).toContain("trap 'exit 130' HUP INT TERM");
    expect(readme).toContain(
      'rm -rf --one-file-system -- "$BOOTSTRAP_DIR" || status=1',
    );

    expect(readme).toContain('MAX_ARCHIVE_BYTES=$((8 * 1024 * 1024 * 1024))');
    expect(readme).toContain('MAX_SIGNATURE_BYTES=$((16 * 1024))');
    expect(readme).toContain('MAX_CHECKSUM_BYTES=256');
    expect(readme).toContain('SPACE_RESERVE_BYTES=$((256 * 1024 * 1024))');
    expect(readme).toContain(
      'open_flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK',
    );
    expect(readme).toContain('descriptor = os.open(source_path, open_flags)');
    expect(readme).toContain('source_stat = os.fstat(descriptor)');
    expect(readme).toContain('if not stat.S_ISREG(source_stat.st_mode):');
    expect(readme).toContain(
      'if source_stat.st_size <= 0 or source_stat.st_size > cap:',
    );
    expect(readme).toContain(
      'required_bytes = sum(item[3] for item in opened) + reserve_bytes',
    );
    expect(readme).toContain(
      'os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW',
    );
    expect(readme).toContain(
      "raise ValueError(f'upload grew while copying: {source_path}')",
    );
    expect(readme).toContain('os.fsync(target_fd)');
    expect(readme).toContain('os.fsync(directory_fd)');
    expect(readme).toContain(
      '[ "$(stat -c \'%u:%g:%a\' -- "$snapshot_file")" = \'0:0:600\' ]',
    );
    expect(readme).toContain(
      'REQUIRED_BYTES=$((UNPACKED_BYTES + SPACE_RESERVE_BYTES))',
    );

    expect(readme).toContain('object_pairs_hook=reject_duplicates');
    expect(readme).toContain('set(envelope) != expected_fields');
    expect(readme).toContain("envelope['file'] != expected_name");
    expect(readme).toContain("actual_digest != envelope['sha256']");
    expect(readme).toContain("re.escape(expected_name.encode('ascii'))");
    expect(readme).toContain(
      "checksum_match.group(1).decode('ascii') != actual_digest",
    );
    expect(readme).toContain("[openssl_path, 'pkeyutl', '-verify', '-pubin'");
    expect(readme).not.toContain('/usr/bin/sha256sum -c');

    expect(readme).toContain('-xzf "$SNAPSHOT_ARCHIVE" -C "$EXTRACT_DIR"');
    expect(readme.indexOf('SNAPSHOT_ARCHIVE=')).toBeLessThan(
      readme.indexOf('"$TRUSTED_PYTHON" -I -S -'),
    );
    expect(readme.indexOf('"$TRUSTED_PYTHON" -I -S -')).toBeLessThan(
      readme.indexOf('-xzf "$SNAPSHOT_ARCHIVE"'),
    );
    expect(readme).not.toContain(
      'sudo install -d -o root -g root -m 0755 /var/tmp/otto-ci-gateway-bootstrap',
    );
    expect(readme).not.toContain('-C /var/tmp/otto-ci-gateway-bootstrap');
  });

  it('validates every install path, serializes replacement, and rolls back partial installs', () => {
    const installer = readFileSync(CI_DEPLOY_GATEWAY_INSTALLER, 'utf8');
    const firstDirectoryInstall = installer.indexOf(
      'install -d -o root -g root -m 0711 "$STATE_ROOT"',
    );
    const targetPreflight = installer.indexOf(
      'for target in "${DIRECTORY_TARGETS[@]}"; do',
    );
    const productionLock = installer.indexOf('/usr/bin/flock -x -w 600 9');
    const firstFixedInstall = installer.indexOf(
      'atomic_install_fixed_file "$GATEWAY_TEMP"',
    );
    const preflight = installer.indexOf(
      'sudo -n -- "$GATEWAY_PATH" preflight >/dev/null',
    );
    const rollbackDisarm = installer.lastIndexOf("ROLLBACK_ARMED='false'");

    expect(installer).toContain('require_root_controlled_target()');
    expect(installer).toContain(
      '[ ! -L "$current" ] || fail "install target ancestry contains a symlink: $current"',
    );
    expect(installer).toContain(
      'fail "install target ancestry is not root-owned: $current"',
    );
    expect(installer).toContain(
      'fail "install target ancestry is group/other writable: $current"',
    );
    expect(targetPreflight).toBeGreaterThan(-1);
    expect(targetPreflight).toBeLessThan(firstDirectoryInstall);
    expect(installer).toContain(
      'PRODUCTION_LOCK="${LOCKS_ROOT}/production.lock"',
    );
    expect(installer).toContain('exec 9>"$PRODUCTION_LOCK"');
    expect(productionLock).toBeGreaterThan(firstDirectoryInstall);
    expect(productionLock).toBeLessThan(firstFixedInstall);

    expect(installer).toContain('atomic_install_fixed_file()');
    for (const fixedInstall of [
      'atomic_install_fixed_file "$GATEWAY_TEMP" "$GATEWAY_PATH" 0755',
      'atomic_install_fixed_file "$PUBLISH_TEMP" "$PUBLISH_PATH" 0755',
      'atomic_install_fixed_file "$ROLLBACK_TEMP" "$ROLLBACK_PATH" 0755',
      'atomic_install_fixed_file "$TRUST_KEY_TEMP" "$TRUST_KEY_PATH" 0644',
      'atomic_install_fixed_file "$CONFIG_PATH_TEMP" "$CONFIG_PATH_FILE" 0600',
      'atomic_install_fixed_file "$DEPLOY_USER_TEMP" "$DEPLOY_USER_FILE" 0600',
      'atomic_install_fixed_file "$SUDOERS_TEMP" "$SUDOERS_PATH" 0440',
    ]) {
      expect(installer).toContain(fixedInstall);
    }
    expect(installer).toContain(
      'next_file="${target_directory}/.${target##*/}.otto-install.$$.${RANDOM}.next"',
    );
    expect(installer).toContain('mv -fT -- "$next_file" "$target"');
    expect(installer).toContain('cp --preserve=all -- "$target" "$backup"');
    expect(installer).toContain('rollback_fixed_files()');
    expect(installer).toContain('mv -fT -- "$next_file" "$target"');
    expect(installer).toContain('rm -f -- "$target"');
    expect(installer).toContain("ROLLBACK_ARMED='true'");
    expect(rollbackDisarm).toBeGreaterThan(preflight);
  });

  it('lets only the pinned deploy user stage exact uploads and cleans every candidate', () => {
    const gateway = readFileSync(CI_DEPLOY_GATEWAY, 'utf8');
    const publisher = readFileSync(PUBLISH_UPDATE_MIRROR, 'utf8');
    const rollback = readFileSync(ROLLBACK_UPDATE_MIRROR, 'utf8');
    const installer = readFileSync(CI_DEPLOY_GATEWAY_INSTALLER, 'utf8');
    const deployWorkflow = readFileSync(DEPLOY_SERVER_WORKFLOW, 'utf8');
    const releaseWorkflow = readFileSync(RELEASE_WORKFLOW, 'utf8');

    expect(installer).toContain("STATE_ROOT='/var/lib/otto-ci-deploy'");
    expect(installer).toContain('UPLOADS_ROOT="${STATE_ROOT}/uploads"');
    expect(installer).toContain('STAGES_ROOT="${STATE_ROOT}/staging"');
    expect(installer).toContain('LOCKS_ROOT="${STATE_ROOT}/locks"');
    expect(installer).toContain('DEPLOYMENTS_ROOT="${STATE_ROOT}/deployments"');
    expect(installer).toContain(
      'install -d -o root -g root -m 0711 \\\n  "$STATE_ROOT" "$UPLOADS_ROOT" "$UPLOAD_ROOT" "$MIRROR_UPLOAD_ROOT"',
    );
    expect(installer).toContain(
      'install -d -o root -g root -m 0700 \\\n  "$STAGES_ROOT" "$LOCKS_ROOT" "$DEPLOYMENTS_ROOT" \\\n  "$STAGING_ROOT" "$MIRROR_STAGING_ROOT"',
    );
    expect(gateway).toContain('STATE_ROOT="/var/lib/otto-ci-deploy"');
    for (const root of [
      '$STATE_ROOT',
      '$UPLOADS_ROOT',
      '$STAGES_ROOT',
      '$LOCKS_ROOT',
      '$DEPLOYMENTS_ROOT',
      '$UPLOAD_ROOT',
      '$MIRROR_UPLOAD_ROOT',
      '$STAGING_ROOT',
      '$MIRROR_STAGING_ROOT',
    ]) {
      expect(gateway).toContain(`require_root_owned_directory "${root}"`);
    }
    expect(gateway).toContain('case "${SUDO_USER:-}" in');
    expect(gateway).toContain('"$DEPLOY_USER")');
    expect(gateway).toContain('|| [ "$COMMAND" = \'upload-file\' ]; then');
    expect(gateway).toContain('mkdir -m 0700 -- "$TRANSACTION_UPLOAD_DIR"');
    expect(gateway).toContain(
      'could not enumerate the upload transaction for quota enforcement',
    );
    expect(gateway).toContain('done < "$UPLOAD_SCAN_FILE"');
    expect(gateway).toContain('chown root:root "$TRANSACTION_UPLOAD_DIR"');
    expect(gateway).toContain(
      '[ "$(stat -c \'%u:%g:%a\' "$UPLOAD_DIR")" = \'0:0:700\' ]',
    );
    expect(gateway).toContain(
      '[ "$(stat -c \'%u:%g:%a\' "$MIRROR_UPLOAD_DIR")" = \'0:0:700\' ]',
    );
    expect(gateway).toContain(
      "fail 'upload exceeds its role-specific size limit'",
    );
    expect(gateway).toContain('UPLOAD_TIMEOUT_SECONDS=1800');
    expect(gateway).toContain(
      'RESULTING_TRANSACTION_BYTES="$((CURRENT_TRANSACTION_BYTES + EXPECTED_SIZE))"',
    );
    expect(gateway).toContain(
      'EXPECTED_SIZE + RESULTING_TRANSACTION_BYTES + 1023',
    );
    expect(gateway).toContain('EXPANDED_ARCHIVE_BYTES="$(/usr/bin/python3');
    expect(gateway).toContain('EXPANDED_ARCHIVE_BYTES + 1023');
    expect(gateway).toContain(
      'staging filesystem does not have capacity to unpack the archive and retain the safety reserve',
    );
    expect(publisher).toContain('missing_asset_bytes=0');
    expect(publisher).toContain('MIN_MIRROR_FREE_RESERVE_KIB=262144');
    expect(publisher).toContain(
      'mirror filesystem does not have capacity for immutable assets and the safety reserve',
    );
    expect(publisher).toContain('newly_installed_assets+=(');
    expect(publisher).toContain("retain_installed_assets='true'");
    expect(
      publisher.indexOf('mkdir -m 0700 -- "$transaction_dir"'),
    ).toBeGreaterThan(
      publisher.indexOf(
        'mirror filesystem does not have capacity for immutable assets and the safety reserve',
      ),
    );
    expect(rollback).toContain(
      'mirror transaction stopped before claiming publication; no public manifest was changed',
    );
    expect(rollback).toContain(
      'mirror transaction stopped before claiming publication and was already marked rolled back',
    );
    expect(rollback).toContain('validate_claimed_asset_ledger');
    expect(rollback).toContain(
      'immutable asset audit ledger does not contain the exact asset set',
    );
    expect(rollback).toContain(
      'version-burned immutable asset does not match its audit ledger',
    );
    expect(rollback).toContain(
      'rollback_started="$transaction_dir/rollback-started"',
    );
    expect(rollback).toContain('capability_sha256=%s');
    expect(rollback).toContain('/usr/bin/sync -f "$rollback_started_next"');
    expect(rollback).toContain(
      'rollback-started record authorizes convergence even after capability expiry',
    );
    expect(rollback).toContain(
      "'format', 'version', 'packageIdentity', 'sourceCommit', 'assets'",
    );
    expect(rollback).toContain("f'Otto-{expected_version}-arm64.dmg.blockmap'");
    expect(rollback).toContain("f'Otto-{expected_version}-x64.dmg.blockmap'");
    expect(rollback).toContain(
      "f'Otto-Setup-{expected_version}-win-x64.exe.blockmap'",
    );
    expect(publisher).toContain(
      'mirror version ${version} was already burned by transaction ${historical_name}',
    );
    expect(publisher).toContain(
      'could not enumerate historical mirror transactions',
    );
    expect(publisher).toContain('done < "$historical_scan_file"');
    expect(publisher).toContain(
      'current mirror owner has an unfinished rollback; refusing a new publication',
    );
    expect(publisher).toContain(
      'if ! /usr/bin/find "$current_owner_transaction"',
    );
    expect(publisher).toContain("-name '.rollback-started.*.next' -print0");
    expect(publisher).toContain(
      "fail 'could not enumerate current owner rollback temporary markers'",
    );
    expect(rollback).toContain(
      'mktemp "$transaction_dir/.rollback-started.XXXXXXXX.next"',
    );
    expect(rollback).toContain('multiple complete rollback-started');
    expect(rollback).toContain('printf -v expected_rollback_started');
    expect(rollback).toContain(
      '/usr/bin/cmp -n "$(stat -c \'%s\' "$candidate")"',
    );
    expect(rollback).toContain(
      'is uncommitted state, so remove it and rebuild after validation',
    );
    expect(rollback).toContain('cleanup_abandoned_publish_temps()');
    expect(rollback).toContain(
      '"${downloads_dir}/.${asset_name}.${transaction_id}.next"',
    );
    expect(rollback).toContain(
      '"${STATE_ROOT}/.mirror-rollback-capability.${transaction_id}.next"',
    );
    expect(rollback).toContain(
      "Remove only this transaction's fixed whitelist.",
    );
    expect(publisher).toContain(
      '"$current_owner_ledger_signature" "$current_owner_capability"',
    );
    expect(publisher).toContain(
      'current mirror owner ledger asset set is invalid',
    );
    const previousStateSync = publisher.indexOf(
      '/usr/bin/sync -f "$transaction_dir"',
    );
    const publishedLedgerInstall = publisher.indexOf(
      'install -o root -g root -m 0600 -- "$staging_dir/latest.json" "$published_manifest"',
    );
    const signedAssetLedgerInstall = publisher.indexOf(
      'install -o root -g root -m 0600 -- "$manifest_path" "$asset_ledger"',
    );
    const claimingInstall = publisher.indexOf(
      'install -o root -g root -m 0600 /dev/null "$transaction_dir/claiming"',
    );
    const assetInstall = publisher.indexOf(
      'install -o root -g root -m 0644 -- "$staging_dir/$asset_name" "$asset_next"',
    );
    const assetFileSync = publisher.indexOf(
      '/usr/bin/sync -f "$asset_next"',
      assetInstall,
    );
    const assetRename = publisher.indexOf(
      'mv -f -- "$asset_next" "$downloads_dir/$asset_name"',
      assetInstall,
    );
    const assetSync = publisher.indexOf(
      '/usr/bin/sync -f "$downloads_dir"',
      assetInstall,
    );
    const ownerMove = publisher.indexOf(
      'mv -f -- "$owner_next" "$CURRENT_OWNER_PATH"',
    );
    const manifestMove = publisher.indexOf(
      'mv -f -- "$latest_next" "$current_manifest"',
    );
    const latestInstall = publisher.indexOf(
      'install -o root -g root -m 0644 -- "$staging_dir/latest.json" "$latest_next"',
    );
    const latestPreSync = publisher.indexOf(
      '/usr/bin/sync -f "$releases_dir"',
      latestInstall,
    );
    expect(previousStateSync).toBeGreaterThan(-1);
    expect(previousStateSync).toBeLessThan(assetInstall);
    expect(publishedLedgerInstall).toBeGreaterThan(previousStateSync);
    expect(signedAssetLedgerInstall).toBeGreaterThan(previousStateSync);
    expect(signedAssetLedgerInstall).toBeLessThan(claimingInstall);
    expect(publishedLedgerInstall).toBeLessThan(claimingInstall);
    expect(claimingInstall).toBeLessThan(assetInstall);
    expect(publisher.indexOf("retain_installed_assets='true'")).toBeLessThan(
      assetInstall,
    );
    expect(assetSync).toBeGreaterThan(assetInstall);
    expect(assetFileSync).toBeGreaterThan(assetInstall);
    expect(assetRename).toBeGreaterThan(assetFileSync);
    expect(assetSync).toBeGreaterThan(assetRename);
    expect(assetSync).toBeLessThan(ownerMove);
    expect(latestPreSync).toBeGreaterThan(latestInstall);
    expect(latestPreSync).toBeLessThan(ownerMove);
    expect(ownerMove).toBeLessThan(manifestMove);
    const rollbackNextInstall = rollback.indexOf(
      'install -o root -g root -m 0644 -- "$previous_manifest" "$rollback_next"',
    );
    const rollbackPreSync = rollback.indexOf(
      '/usr/bin/sync -f "$releases_dir"',
      rollbackNextInstall,
    );
    const rollbackManifestMove = rollback.indexOf(
      'mv -f -- "$rollback_next" "$current_manifest"',
    );
    expect(rollbackPreSync).toBeGreaterThan(rollbackNextInstall);
    expect(rollbackPreSync).toBeLessThan(rollbackManifestMove);
    const rollbackOwnerInstall = rollback.indexOf(
      'install -o root -g root -m 0600 -- "$previous_owner" "$owner_next"',
    );
    const rollbackOwnerPreSync = rollback.indexOf(
      '/usr/bin/sync -f "$STATE_ROOT"',
      rollbackOwnerInstall,
    );
    const rollbackOwnerMove = rollback.indexOf(
      'mv -f -- "$owner_next" "$CURRENT_OWNER_PATH"',
    );
    expect(rollbackOwnerPreSync).toBeGreaterThan(rollbackOwnerInstall);
    expect(rollbackOwnerPreSync).toBeLessThan(rollbackOwnerMove);
    expect(gateway).toContain('os.O_EXCL');
    expect(gateway).toContain("getattr(os, 'O_NOFOLLOW', 0)");
    expect(gateway).toContain('os.fsync(temporary_fd)');
    expect(gateway).toContain('os.fsync(directory_fd)');
    expect(gateway).toContain(
      "|| fail 'transaction upload directory does not contain the exact file set'",
    );
    expect(gateway).toContain(
      "|| fail 'mirror upload directory does not contain the exact file set'",
    );
    expect(gateway).toContain('trap cleanup_deploy_candidate EXIT');
    expect(gateway).toContain('trap cleanup_mirror_candidate EXIT');
    expect(gateway).toContain(
      'rm -rf --one-file-system -- "$STAGING_DIR" "$UPLOAD_DIR"',
    );
    expect(gateway).toContain(
      'rm -rf --one-file-system -- "$MIRROR_STAGING_DIR" "$MIRROR_UPLOAD_DIR"',
    );

    expect(deployWorkflow).toContain(
      'prepare-upload enterprise "$DEPLOY_TRANSACTION_ID"',
    );
    expect(deployWorkflow).toContain(
      'upload-file enterprise "$DEPLOY_TRANSACTION_ID" "$role" "$size" "$digest"',
    );
    expect(deployWorkflow).toContain(
      'cleanup-upload enterprise "$DEPLOY_TRANSACTION_ID"',
    );
    expect(deployWorkflow).toContain(
      "if: ${{ always() && steps.ssh.outcome == 'success' }}",
    );
    expect(releaseWorkflow).toContain(
      'prepare-upload mirror "$MIRROR_TRANSACTION_ID"',
    );
    expect(releaseWorkflow).toContain(
      'upload-file mirror "$MIRROR_TRANSACTION_ID" "$role" "$size" "$digest"',
    );
    expect(releaseWorkflow).toContain(
      'cleanup-upload mirror "$MIRROR_TRANSACTION_ID"',
    );
    expect(releaseWorkflow).toContain(
      "if: ${{ always() && steps.mirror_ssh.outcome == 'success' }}",
    );
    for (const workflow of [deployWorkflow, releaseWorkflow]) {
      expect(workflow).not.toContain("install -d -m 0700 '$REMOTE_DIR'");
      expect(workflow).not.toMatch(/^\s*scp\s/gm);
    }
  });

  it('serializes deployment and mirror transactions before mutating root-owned state', () => {
    const gateway = readFileSync(CI_DEPLOY_GATEWAY, 'utf8');
    const publisher = readFileSync(PUBLISH_UPDATE_MIRROR, 'utf8');
    const rollback = readFileSync(ROLLBACK_UPDATE_MIRROR, 'utf8');

    expect(gateway).toContain('acquire_production_lock()');
    expect(gateway).toContain(
      'local lock_path="${LOCKS_ROOT}/production.lock"',
    );
    expect(gateway).toContain('/usr/bin/flock -x -w 600 9');
    expect(gateway).toContain(
      "[ -x /usr/bin/flock ] || fail 'required /usr/bin/flock is unavailable'",
    );
    expect(
      gateway.match(/acquire_production_lock/g).length,
    ).toBeGreaterThanOrEqual(7);
    expect(gateway).toContain(
      '[ "${PRODUCTION_LOCK_HELD:-false}" = \'true\' ]',
    );
    const earlyProductionLock = gateway.indexOf(
      'acquire_production_lock\nverify_running_gateway_identity',
    );
    expect(earlyProductionLock).toBeGreaterThan(-1);
    expect(earlyProductionLock).toBeLessThan(
      gateway.indexOf('require_root_owned_regular_file "$GATEWAY_PATH"'),
    );
    const runningIdentity = gateway.indexOf(
      'verify_running_gateway_identity\n',
      earlyProductionLock,
    );
    expect(runningIdentity).toBeGreaterThan(earlyProductionLock);
    expect(runningIdentity).toBeLessThan(
      gateway.indexOf('for trusted_directory in'),
    );
    expect(gateway).toContain('running_gateway_fd="/proc/$$/fd/255"');
    expect(gateway).toContain(
      'running gateway inode does not match the locked fixed gateway',
    );
    expect(gateway).toContain('mkdir -m 0700 -- "$STAGING_DIR"');
    expect(gateway).toContain('mkdir -m 0700 -- "$MIRROR_STAGING_DIR"');

    for (const helper of [publisher, rollback]) {
      expect(helper).toContain(
        "readonly LOCKS_ROOT='/var/lib/otto-ci-deploy/locks'",
      );
      expect(helper).toContain('exec 8>"$mirror_lock_path"');
      expect(helper).toContain('/usr/bin/flock -x -w 600 8');
      expect(helper).toContain(
        "[[ -x /usr/bin/sync ]] || fail 'required /usr/bin/sync is unavailable'",
      );
    }
    expect(publisher.indexOf('/usr/bin/flock -x -w 600 8')).toBeLessThan(
      publisher.indexOf(
        'previous_manifest="$transaction_dir/previous-latest.json"',
      ),
    );
    expect(rollback.indexOf('/usr/bin/flock -x -w 600 8')).toBeLessThan(
      rollback.indexOf('if [[ ! -d "$transaction_dir" ]]; then'),
    );
    expect(publisher).toContain('mkdir -m 0700 -- "$transaction_dir"');
    expect(publisher).toContain('trap cleanup_publish_next_files EXIT');
    expect(publisher).toContain('publish_next_files+=("$asset_next")');
    expect(publisher).toContain('publish_next_files+=("$latest_next")');
    expect(rollback).toContain('trap cleanup_rollback_next_files EXIT');
    expect(publisher).not.toContain(
      'install -d -o root -g root -m 0700 "$transaction_dir"',
    );
  });

  it('binds the signed release manifest and deployed target to the exact package identity', () => {
    const gateway = readFileSync(CI_DEPLOY_GATEWAY, 'utf8');

    expect(gateway).toContain('EXPECTED_BUILD_PREFIX="${PACKAGE_ID%%-*}"');
    expect(gateway).toContain(
      'EXPECTED_SOURCE_INPUT_PREFIX="${PACKAGE_ID#*-}"',
    );
    expect(gateway).toContain(
      '"$RELEASE_MANIFEST" "$EXPECTED_VERSION" \\\n  "$EXPECTED_BUILD_PREFIX" "$EXPECTED_SOURCE_INPUT_PREFIX"',
    );
    expect(gateway).toContain('build_commit[:12] != expected_build');
    expect(gateway).toContain('source_input[:12] != expected_source');
    expect(gateway).toContain(
      'local expected_release="${INSTALL_ROOT}/releases/${expected_version}-${expected_build_prefix}"',
    );
    expect(gateway).toContain('[ "$current_release" = "$expected_release" ]');
    expect(gateway).toContain(
      'require_root_owned_directory_chain "$current_release"',
    );
    expect(gateway).toContain(
      'require_root_owned_directory_chain "${INSTALL_ROOT}/deploy"',
    );
    expect(gateway).toContain(
      '"$EXPECTED_VERSION" "$PACKAGE_ID" "$EXPECTED_SOURCE_COMMIT"',
    );
    expect(gateway).not.toContain(
      '"${INSTALL_ROOT}/releases/${EXPECTED_VERSION}-"*)',
    );
  });

  it('never replaces bytes already published under the same versioned asset name', () => {
    const publisher = readFileSync(PUBLISH_UPDATE_MIRROR, 'utf8');
    const immutableCheck = publisher.indexOf(
      'if [[ -e "$installed_asset" || -L "$installed_asset" ]]; then',
    );
    const manifestBackup = publisher.indexOf(
      'previous_manifest="$transaction_dir/previous-latest.json"',
    );
    const assetPublication = publisher.indexOf(
      'mv -f -- "$asset_next" "$downloads_dir/$asset_name"',
    );

    expect(immutableCheck).toBeGreaterThan(-1);
    expect(manifestBackup).toBeGreaterThan(immutableCheck);
    expect(assetPublication).toBeGreaterThan(manifestBackup);
    expect(publisher).toContain(
      'refusing to replace an existing version with different bytes',
    );
    expect(publisher).toContain(
      'require_root_owned_nonwritable_path "$installed_asset"',
    );
    expect(publisher).toContain(
      'existing desktop asset is not web-readable mode 0644',
    );
    expect(publisher).toContain(
      'require_root_owned_nonwritable_path "$current_manifest"',
    );
    expect(publisher).toContain(
      '[[ "$(sha256sum -- "$installed_asset" | awk \'{print $1}\')" == "${manifest_hashes[$asset_name]}" ]]',
    );
    expect(publisher).toContain(
      'if [[ -f "$downloads_dir/$asset_name" ]]; then\n    continue',
    );
  });

  it('prevents update-mirror downgrade and same-version manifest mutation', () => {
    const publisher = readFileSync(PUBLISH_UPDATE_MIRROR, 'utf8');

    expect(publisher).toContain('/usr/bin/python3 -I -S - \\');
    expect(publisher).toContain(
      "raise SystemExit('refusing to downgrade the desktop update mirror')",
    );
    expect(publisher).toContain(
      "raise SystemExit('refusing to mutate latest.json for an already published version')",
    );
    expect(publisher).toContain(
      'if candidate_version == current_version and candidate_path.read_bytes() != current_path.read_bytes():',
    );
  });

  it('binds mirror publication to the exact deployed enterprise identity', () => {
    const gateway = readFileSync(CI_DEPLOY_GATEWAY, 'utf8');
    const publishStart = gateway.indexOf(
      'if [ "$COMMAND" = \'publish-mirror\' ]; then',
    );
    const rollbackStart = gateway.indexOf(
      'if [ "$COMMAND" = \'rollback-mirror\' ]; then',
    );
    const publishBranch = gateway.slice(publishStart, rollbackStart);
    const identityVerification = publishBranch.indexOf(
      'verify_current_deployment \\\n    "$EXPECTED_VERSION" "$PACKAGE_ID" "$EXPECTED_SOURCE_COMMIT"',
    );

    expect(publishStart).toBeGreaterThan(-1);
    expect(rollbackStart).toBeGreaterThan(publishStart);
    expect(publishBranch).toContain(
      '[ "$#" -eq 5 ] || fail \'usage: publish-mirror TRANSACTION VERSION PACKAGE_ID SOURCE_COMMIT\'',
    );
    expect(identityVerification).toBeGreaterThan(-1);
    expect(publishBranch).toContain('verify_update_mirror_manifest \\');
    expect(publishBranch).toContain(
      '"$EXPECTED_VERSION" "$PACKAGE_ID" "$EXPECTED_SOURCE_COMMIT"',
    );
    expect(
      publishBranch.indexOf('"$PUBLISH_HELPER_PATH" "$TRANSACTION_ID"'),
    ).toBeGreaterThan(identityVerification);
  });

  it('rejects a stale rollback after another transaction owns latest.json', () => {
    const publisher = readFileSync(PUBLISH_UPDATE_MIRROR, 'utf8');
    const rollback = readFileSync(ROLLBACK_UPDATE_MIRROR, 'utf8');
    const ownershipCheck = rollback.indexOf(
      'if [[ "$current_owner" != "$transaction_id" ]]; then',
    );
    const staleFailure = rollback.indexOf(
      'current public manifest no longer belongs to this transaction; refusing stale rollback',
    );
    const manifestIdentityCheck = rollback.indexOf(
      'cmp -s -- "$current_manifest" "$published_manifest"',
    );
    const restore = rollback.lastIndexOf(
      'mv -f -- "$rollback_next" "$current_manifest"',
    );

    expect(publisher).toContain(
      'published_manifest="$transaction_dir/published-latest.json"',
    );
    expect(publisher).toContain(
      'install -o root -g root -m 0600 -- "$staging_dir/latest.json" "$published_manifest"',
    );
    expect(publisher).toContain(
      "readonly CURRENT_OWNER_PATH='/var/lib/otto-ci-deploy/mirror-current-owner'",
    );
    expect(publisher).toContain('mv -f -- "$owner_next" "$CURRENT_OWNER_PATH"');
    expect(publisher).toContain(
      'install -o root -g root -m 0600 /dev/null "$transaction_dir/committed"',
    );
    expect(publisher).toContain(
      'current_owner_transaction="$transactions_dir/$current_owner_value"',
    );
    expect(publisher).toContain('"$current_owner_transaction/claiming"');
    expect(publisher).toContain('"$current_owner_transaction/committed"');
    expect(publisher).toContain(
      "|| fail 'current mirror owner transaction is marked rolled back'",
    );
    expect(publisher).toContain(
      'cmp -s -- "$current_manifest" "$current_owner_manifest"',
    );
    expect(rollback).toContain(
      'published_manifest="$transaction_dir/published-latest.json"',
    );
    expect(ownershipCheck).toBeGreaterThan(-1);
    expect(staleFailure).toBeGreaterThan(ownershipCheck);
    expect(manifestIdentityCheck).toBeGreaterThan(ownershipCheck);
    expect(restore).toBeGreaterThan(staleFailure);
    expect(rollback).toContain('restore_previous_owner');
    expect(rollback).toContain(
      'if [[ -f "$transaction_dir/rolled-back" ]]; then',
    );
    expect(rollback).toContain(
      'require_root_owned_nonwritable_path "$transaction_file"',
    );
    expect(rollback).toContain(
      'require_root_owned_nonwritable_path "$current_manifest"',
    );
    expect(rollback).toContain(
      'if [[ "$current_owner" != "$transaction_id" ]]; then\n  if previous_state_is_current; then',
    );
    expect(rollback).not.toContain(
      'if [[ ! -f "$transaction_dir/committed" ]] && previous_state_is_current; then',
    );
    expect(rollback).toContain(
      "|| fail 'current mirror owner has no published manifest; refusing an unverifiable rollback'",
    );
    expect(rollback).toContain(
      "|| fail 'mirror transaction has no published manifest and its previous state is not current'",
    );
    expect(publisher).toContain('/usr/bin/sync -f "$STATE_ROOT"');
    expect(publisher).toContain('/usr/bin/sync -f "$releases_dir"');
    expect(rollback).toContain('/usr/bin/sync -f "$transaction_dir"');
    expect(rollback).toContain('/usr/bin/sync -f "$STATE_ROOT"');
    expect(rollback).toContain('/usr/bin/sync -f "$releases_dir"');
    expect(rollback).toContain("printf 'restored_manifest_sha256=%s\\n'");
    expect(rollback).toContain("printf 'restored_manifest_sha256=absent\\n'");
  });

  it('packages every gateway component and normalizes it to executable mode', () => {
    const bundle = readFileSync(BUNDLE_SCRIPT, 'utf8');
    const executableFiles =
      bundle.match(/const executableFiles = \[([\s\S]*?)\n\s{2}\];/)?.[1] ?? '';

    for (const component of [
      'ci-deploy-gateway.sh',
      'install-ci-deploy-gateway.sh',
      'ci/publish-update-mirror.sh',
      'ci/rollback-update-mirror.sh',
    ]) {
      expect(executableFiles).toContain(`    '${component}',`);
    }
    expect(bundle).toContain(
      'chmodSync(path.join(finalPackageRoot, script), 0o755)',
    );
  });
});

describe('enterprise one-click provenance contract', () => {
  it('deletes incremental outputs before rebuilding packaged server code', () => {
    const bundle = readFileSync(BUNDLE_SCRIPT, 'utf8');
    const buildLoop = bundle.match(
      /for \(const workspace of enterpriseBuildWorkspaces\) \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(bundle).toContain(
      "const enterpriseBuildWorkspaces = ['otto-core', 'otto-server'];",
    );
    expect(buildLoop).toBeDefined();
    expect(buildLoop).toContain(
      "path.join(repoRoot, 'packages', packageDirectory, 'dist')",
    );
    expect(buildLoop).toContain('recursive: true');
    expect(buildLoop).toContain('force: true');
    expect(buildLoop.indexOf('rmSync(')).toBeLessThan(
      buildLoop.indexOf("run(npmCommand, ['run', 'build'"),
    );
  });

  it('packages every server runtime adapter export and starts the extracted archive offline', () => {
    const bundle = readFileSync(BUNDLE_SCRIPT, 'utf8');
    expect(bundle).toContain("'services/recurringTaskRegistry.js'");
    expect(bundle).toContain("'memory/globalMemoryMaintenance.js'");
    expect(bundle).toContain(
      "export * from './src/services/recurringTaskRegistry.js';",
    );
    expect(bundle).toContain(
      "export * from './src/memory/globalMemoryMaintenance.js';",
    );
    expect(bundle).toContain(
      "export * from './src/customer-modules/index.js';",
    );
    expect(bundle).toContain("path.join(coreDist, 'customer-modules')");
    expect(bundle).toContain(
      "typeof coreAdapter.atomicWriteTextFile !== 'function'",
    );
    expect(bundle).toContain(
      "run('tar', ['-xzf', archive, '-C', archiveSmokeRoot])",
    );
    expect(bundle).toContain(
      "path.join(archiveSmokeRoot, finalPackageName, 'release')",
    );
    expect(bundle.match(/smokeEnterpriseRuntime\(/gu)?.length).toBe(3);
  });

  it('normalizes executable modes inside archives built on Windows', () => {
    const bundle = readFileSync(BUNDLE_SCRIPT, 'utf8');

    expect(bundle).toContain('function normalizeTarExecutableModes(');
    expect(bundle).toContain('writeTarMode(tar, entry.offset, mode)');
    expect(bundle).toContain("'release/run.mjs'");
    expect(bundle).toMatch(
      /normalizeTarExecutableModes\(\s*temporaryTar,\s*finalPackageName,\s*executableFiles\s*\);/,
    );
    expect(bundle).toContain(
      "['--no-xattrs', '-cf', temporaryTar, '-C', temporaryRoot, finalPackageName]",
    );
    expect(bundle).toContain(
      'gzipSync(readFileSync(temporaryTar), { level: 9 })',
    );
  });

  it('tracks every root build input in both dirty scope and source hashes', () => {
    const bundle = readFileSync(BUNDLE_SCRIPT, 'utf8');
    const sourceScope =
      bundle.match(/const sourceScope = \[([\s\S]*?)\n\];/)?.[1] ?? '';
    const sourceInputFiles =
      bundle.match(
        /const sourceInputFiles = \[([\s\S]*?)\n\]\.sort\(\);/,
      )?.[1] ?? '';

    for (const input of [
      'tsconfig.json',
      'scripts/build_package.js',
      'packages/core/src/services/recurringTaskRegistry.ts',
      'packages/core/src/memory/globalMemoryMaintenance.ts',
      'packages/core/src/customer-modules',
    ]) {
      expect(sourceScope).toContain(`  '${input}',`);
      expect(sourceInputFiles).toContain(input);
    }
  });
});

describe('enterprise upgrade retry and installed-layout contract', () => {
  it('uses the direct current/manifest.json layout verified by install and upgrade', () => {
    const gateway = readFileSync(CI_DEPLOY_GATEWAY, 'utf8');
    const integration = readFileSync(
      path.resolve('scripts/tests/enterprise-ci-linux-integration.sh'),
      'utf8',
    );

    expect(gateway).toContain(
      'require_root_owned_regular_file "${current_release}/manifest.json"',
    );
    expect(gateway).toContain(
      'CURRENT_RELEASE_MANIFEST="${CURRENT_RELEASE}/manifest.json"',
    );
    expect(gateway).toContain(
      'PREVIOUS_MANIFEST="${PREVIOUS_CURRENT}/manifest.json"',
    );
    expect(gateway).not.toContain('${current_release}/release/manifest.json');
    expect(integration).toContain(
      '/opt/otto-enterprise/releases/1.9.14-aaaaaaaaaaaa/manifest.json',
    );
    expect(integration).not.toContain(
      '/opt/otto-enterprise/releases/1.9.14-aaaaaaaaaaaa/release/manifest.json',
    );
  });

  it('atomically stages new targets and only reuses an exact verified leftover', () => {
    const upgrade = readFileSync(UPGRADE_SH, 'utf8');
    const exactManifest = upgrade.indexOf(
      'cmp -s -- "${SCRIPT_DIR}/release/manifest.json"',
    );
    const existingVerify = upgrade.indexOf(
      '"$TARGET_RELEASE" >/dev/null',
      exactManifest,
    );
    const stage = upgrade.indexOf(
      'TARGET_RELEASE_STAGE="${TARGET_RELEASE}.next-$(date -u +%Y%m%dT%H%M%SZ)-$$"',
    );
    const stageCopy = upgrade.indexOf(
      'cp -a "${SCRIPT_DIR}/release" "$TARGET_RELEASE_STAGE"',
      stage,
    );
    const stageVerify = upgrade.indexOf(
      '"$TARGET_RELEASE_STAGE" >/dev/null',
      stageCopy,
    );
    const stageSync = upgrade.indexOf(
      '/usr/bin/sync -f "$TARGET_RELEASE_STAGE"',
      stageVerify,
    );
    const atomicPublish = upgrade.indexOf(
      'mv -T -- "$TARGET_RELEASE_STAGE" "$TARGET_RELEASE"',
      stageSync,
    );

    expect(exactManifest).toBeGreaterThan(-1);
    expect(existingVerify).toBeGreaterThan(exactManifest);
    expect(stage).toBeGreaterThan(existingVerify);
    expect(stageCopy).toBeGreaterThan(stage);
    expect(stageVerify).toBeGreaterThan(stageCopy);
    expect(stageSync).toBeGreaterThan(stageVerify);
    expect(atomicPublish).toBeGreaterThan(stageSync);
    expect(upgrade).toContain(
      'rm -rf --one-file-system -- "$TARGET_RELEASE_STAGE"',
    );
    expect(upgrade).not.toContain(
      'rm -rf --one-file-system -- "$TARGET_RELEASE"',
    );
  });

  it('keeps shell helpers outside the durable witness Node heredoc', () => {
    const upgrade = readFileSync(UPGRADE_SH, 'utf8');
    const witnessStart = upgrade.indexOf('write_rollback_verified_witness() {');
    const heredocEnd = upgrade.indexOf('\nNODE\n', witnessStart);
    const syncHelper = upgrade.indexOf(
      'sync_live_deployment_filesystems() {',
      witnessStart,
    );
    expect(heredocEnd).toBeGreaterThan(witnessStart);
    expect(syncHelper).toBeGreaterThan(heredocEnd);
  });

  it('never adopts an older unfinished transaction by package identity', () => {
    const gateway = readFileSync(CI_DEPLOY_GATEWAY, 'utf8');
    expect(gateway).toContain(
      '[ "$UNFINISHED_TRANSACTION_ID" = "$TRANSACTION_ID" ]',
    );
    expect(gateway).toContain(
      'an older exact deployment transaction requires explicit reconciliation before a new run',
    );
  });
});
