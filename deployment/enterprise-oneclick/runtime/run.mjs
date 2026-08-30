#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const host = required('OTTO_ENTERPRISE_HOST');
if (host !== '127.0.0.1') {
  throw new Error(
    'OTTO_ENTERPRISE_HOST must be 127.0.0.1 in the managed deployment',
  );
}
const port = Number(required('OTTO_ENTERPRISE_PORT'));
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(
    'OTTO_ENTERPRISE_PORT must be an integer between 0 and 65535',
  );
}
const readinessFileValue = process.env.OTTO_ENTERPRISE_READY_FILE?.trim();
const readinessFile = readinessFileValue
  ? path.resolve(readinessFileValue)
  : null;
if (readinessFile && !path.isAbsolute(readinessFileValue)) {
  throw new Error('OTTO_ENTERPRISE_READY_FILE must be an absolute path');
}
if (readinessFile) {
  const readinessDirectoryMetadata = fs.lstatSync(path.dirname(readinessFile));
  if (
    readinessDirectoryMetadata.isSymbolicLink() ||
    !readinessDirectoryMetadata.isDirectory()
  ) {
    throw new Error(
      'OTTO_ENTERPRISE_READY_FILE parent must be a regular directory',
    );
  }
  if (fs.existsSync(readinessFile)) {
    throw new Error('OTTO_ENTERPRISE_READY_FILE must not already exist');
  }
}
const publicUrl = required('OTTO_ENTERPRISE_PUBLIC_URL');
const parsedPublicUrl = new URL(publicUrl);
if (
  parsedPublicUrl.protocol !== 'https:' ||
  parsedPublicUrl.username ||
  parsedPublicUrl.password
) {
  throw new Error(
    'OTTO_ENTERPRISE_PUBLIC_URL must be a credential-free HTTPS URL',
  );
}
const appVersion = required('OTTO_APP_VERSION');
const buildCommit = required('OTTO_BUILD_COMMIT');
if (!/^[0-9a-f]{40}$/i.test(buildCommit)) {
  throw new Error(
    'OTTO_BUILD_COMMIT must be a 40-character hexadecimal build id',
  );
}
const adminToken = required('OTTO_ENTERPRISE_ADMIN_TOKEN');
if (adminToken.length < 32) {
  throw new Error(
    'OTTO_ENTERPRISE_ADMIN_TOKEN must contain at least 32 characters',
  );
}
if (required('OTTO_ENTERPRISE_TRUST_PROXY_HOPS') !== '1') {
  throw new Error(
    'OTTO_ENTERPRISE_TRUST_PROXY_HOPS must be exactly 1 behind managed Caddy',
  );
}

const licenseTrustFile = path.resolve(required('OTTO_LICENSE_TRUST_FILE'));
const trustMetadata = fs.lstatSync(licenseTrustFile);
if (trustMetadata.isSymbolicLink() || !trustMetadata.isFile()) {
  throw new Error(
    'OTTO_LICENSE_TRUST_FILE must be a regular file from the signed release',
  );
}
const licensePublicKeys = JSON.parse(fs.readFileSync(licenseTrustFile, 'utf8'));
if (
  !Array.isArray(licensePublicKeys) ||
  licensePublicKeys.length === 0 ||
  licensePublicKeys.some(
    (key) => typeof key !== 'string' || !key.includes('BEGIN PUBLIC KEY'),
  )
) {
  throw new Error('signed release license trust store is invalid');
}
process.env.NODE_ENV = 'production';
process.env.OTTO_LICENSE_ENFORCE = 'true';
process.env.OTTO_LICENSE_PUBLIC_KEYS = JSON.stringify(licensePublicKeys);

const { closeEnterpriseDatabase } = await import('./src/enterprise/db.js');
const { ENTERPRISE_TASK_DRAIN_TIMEOUT_MS, startEnterpriseServer } =
  await import('./src/enterprise/server.js');

if (
  !Number.isSafeInteger(ENTERPRISE_TASK_DRAIN_TIMEOUT_MS) ||
  ENTERPRISE_TASK_DRAIN_TIMEOUT_MS <= 0
) {
  throw new Error('enterprise task drain timeout contract is invalid');
}
const SHUTDOWN_HTTP_GRACE_MS = 15_000;
const FORCE_SHUTDOWN_TIMEOUT_MS =
  ENTERPRISE_TASK_DRAIN_TIMEOUT_MS + SHUTDOWN_HTTP_GRACE_MS;

const server = startEnterpriseServer({
  host,
  port,
  publicUrl,
  adminToken,
  appVersion,
  buildCommit,
});

if (readinessFile) {
  server.once('listening', () => {
    try {
      const address = server.address();
      if (
        !address ||
        typeof address === 'string' ||
        address.address !== host ||
        !Number.isInteger(address.port) ||
        address.port < 1 ||
        address.port > 65535
      ) {
        throw new Error('server did not bind a valid loopback TCP address');
      }
      fs.writeFileSync(
        readinessFile,
        `${JSON.stringify({
          host: address.address,
          port: address.port,
          version: appVersion,
          buildCommit,
        })}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      );
    } catch (error) {
      process.stderr.write(
        `[Otto Enterprise] cannot publish canary readiness: ${error.message}\n`,
      );
      shutdown('readiness publication failure', 1);
    }
  });
}

let stopping = false;
function shutdown(signal, successExitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.stdout.write(
    `[Otto Enterprise] ${signal} received, draining connections\n`,
  );
  const forceTimer = setTimeout(() => {
    process.stderr.write('[Otto Enterprise] graceful shutdown timed out\n');
    server.closeAllConnections?.();
    // The server may still have an accepted external write in progress. A hard
    // process stop is safer than closing SQLite underneath that write.
    process.exit(1);
  }, FORCE_SHUTDOWN_TIMEOUT_MS);
  server.close((error) => {
    if (error) {
      process.stderr.write(
        `[Otto Enterprise] shutdown failed: ${error.message}\n`,
      );
      process.exitCode = 1;
      // Keep the outer watchdog referenced. A drain timeout means work may
      // still be running, so neither the database nor the process is torn down
      // before the full drain + HTTP budget expires.
      return;
    }
    clearTimeout(forceTimer);
    closeEnterpriseDatabase();
    process.exit(successExitCode);
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
